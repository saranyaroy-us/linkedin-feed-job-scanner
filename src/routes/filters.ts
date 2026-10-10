import * as z from 'zod';
import { WORK_MODES } from '../domain/raw-post';
import { dateInZone, isYmd } from '../lib/time';
import type { PostFilters } from '../storage/posts.repository';

const text = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => v || undefined)
  .catch(undefined);
const ymd = z
  .string()
  .refine(isYmd)
  .optional()
  .catch(undefined);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max).optional().catch(undefined);

/** Query-string filters shared by the dashboard and /api/posts. Invalid values are ignored. */
const FilterQuerySchema = z.object({
  query: text,
  company: text,
  work_mode: z.enum(WORK_MODES).optional().catch(undefined),
  author: text,
  author_type: z.enum(['profile', 'company']).optional().catch(undefined),
  from: ymd,
  to: ymd,
  q: text,
});

export function parseFilters(query: Record<string, string>): PostFilters {
  const parsed = FilterQuerySchema.parse(query);
  return {
    query: parsed.query,
    company: parsed.company,
    workMode: parsed.work_mode,
    author: parsed.author,
    authorType: parsed.author_type,
    from: parsed.from,
    to: parsed.to,
    text: parsed.q,
  };
}

/** Parses an integer query parameter, falling back to `fallback` when absent or out of range. */
export function parseIntParam(value: string | undefined, min: number, max: number, fallback: number): number {
  return int(min, max).parse(value) ?? fallback;
}

/**
 * Company, author and free-text filters cannot use an index, so without a
 * date range they would scan every stored post (billed per row by D1). When
 * any of them is set and no `from` date is given, the search covers the last
 * SEARCH_WINDOW_DAYS.
 */
export const SEARCH_WINDOW_DAYS = 90;

export function withSearchWindow(
  filters: PostFilters,
  now: Date,
  timeZone: string,
): { filters: PostFilters; windowFrom: string | null } {
  if ((!filters.text && !filters.author && !filters.company) || filters.from) return { filters, windowFrom: null };
  const from = dateInZone(new Date(now.getTime() - SEARCH_WINDOW_DAYS * 86_400_000), timeZone);
  return { filters: { ...filters, from, fromIncludesUndated: true }, windowFrom: from };
}

/** True when no filter is set (exact totals are then known without scanning). */
export const hasNoFilters = (f: PostFilters) =>
  !f.query && !f.company && !f.workMode && !f.author && !f.authorType && !f.from && !f.to && !f.text;

/** True when only the search-query filter is set (its total is in post_query_counts). */
export const hasOnlyQueryFilter = (f: PostFilters) =>
  !!f.query && !f.company && !f.workMode && !f.author && !f.authorType && !f.from && !f.to && !f.text;
