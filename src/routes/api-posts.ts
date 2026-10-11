import type { Context } from 'hono';
import type { AppEnv } from '../config/env';
import { resolveTimeZone } from '../lib/time';
import { PostsRepository, type ListedPost } from '../storage/posts.repository';
import { parseFilters, parseIntParam, parseRelevanceView, withRelevance, withSearchWindow } from './filters';

export const API_DEFAULT_LIMIT = 50;
export const API_MAX_LIMIT = 100;
/** raw_json rows are large; keep raw pages small to stay inside the CPU budget. */
export const API_MAX_RAW_LIMIT = 20;
const MAX_OFFSET = 10_000;

/** Normalized post for JSON with its relevance classification: tagged companies parsed; raw_json only when requested. */
export function toApiPost(post: ListedPost) {
  const { tagged_companies_json, raw_json, ...rest } = post;
  let tagged_companies: unknown = null;
  if (tagged_companies_json) {
    try {
      tagged_companies = JSON.parse(tagged_companies_json);
    } catch {
      tagged_companies = null;
    }
  }
  return raw_json === undefined ? { ...rest, tagged_companies } : { ...rest, tagged_companies, raw_json };
}

/**
 * GET /api/posts — read-only normalized posts. Same filters as the dashboard
 * (query, company, work_mode, author, author_type, from, to, q) plus limit/offset, and
 * relevance (relevant | needs_review | unrelated | not_a_job | all; default all).
 * raw_json is omitted unless include_raw=1.
 */
export function apiPostsHandler(options: { now?: () => Date } = {}) {
  return async (c: Context<AppEnv>) => {
    const includeRaw = c.req.query('include_raw') === '1' || c.req.query('include_raw') === 'true';
    const maxLimit = includeRaw ? API_MAX_RAW_LIMIT : API_MAX_LIMIT;
    const limit = parseIntParam(c.req.query('limit'), 1, maxLimit, Math.min(API_DEFAULT_LIMIT, maxLimit));
    const offset = parseIntParam(c.req.query('offset'), 0, MAX_OFFSET, 0);

    const timeZone = resolveTimeZone(c.env.DISPLAY_TIMEZONE);
    const now = options.now?.() ?? new Date();
    const { filters, windowFrom } = withSearchWindow(parseFilters(c.req.query()), now, timeZone);
    const view = parseRelevanceView(c.req.query('relevance'), 'all');
    const result = await new PostsRepository(c.env.DB).search(withRelevance(filters, view), {
      limit,
      offset,
      timeZone,
      includeRawJson: includeRaw,
    });

    return c.json({
      limit,
      offset,
      relevance: view,
      has_more: result.hasMore,
      // Set when an author/text search was limited to recent posts (no `from` given).
      search_window_from: windowFrom,
      posts: result.posts.map(toApiPost),
    });
  };
}
