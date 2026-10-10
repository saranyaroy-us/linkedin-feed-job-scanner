import type { Context } from 'hono';
import * as z from 'zod';
import { createApifyClient, type FetchLike } from '../apify/client';
import type { AppEnv } from '../config/env';
import { SearchWindowSchema, type SearchWindow } from '../domain/search-run';
import { isYmd, resolveTimeZone } from '../lib/time';
import { parseSearchRequest, startManualSearch, type SearchForm } from '../search/manual-search';

/** Outcome of a Run Search submission, shown on the dashboard after the redirect. */
export const SearchMessageSchema = z.enum([
  'started',
  'busy',
  'invalid_window',
  'missing_dates',
  'from_after_to',
  'future_to',
  'not_configured',
  'failed',
]);
export type SearchMessage = z.infer<typeof SearchMessageSchema>;

/** The Run Search form as the dashboard shows it: a message and the values to fill back in. */
export interface SearchFormState {
  message: SearchMessage | null;
  window: SearchWindow;
  rangeFrom: string;
  rangeTo: string;
}

const optional = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const ymd = optional(z.string().refine(isYmd));
const SearchFormQuerySchema = z.object({
  search: optional(SearchMessageSchema),
  window: optional(SearchWindowSchema),
  range_from: ymd,
  range_to: ymd,
});

/** Reads the form state from the dashboard's query string. Invalid values are ignored. */
export function parseSearchFormState(query: Record<string, string>): SearchFormState {
  const parsed = SearchFormQuerySchema.parse(query);
  return {
    message: parsed.search ?? null,
    window: parsed.window ?? '24h',
    rangeFrom: parsed.range_from ?? '',
    rangeTo: parsed.range_to ?? '',
  };
}

/** Dashboard URL for a message; after a rejected range the chosen dates are filled back in. */
function dashboardHref(message: SearchMessage, form: SearchForm): string {
  const params = new URLSearchParams({ search: message });
  if (message !== 'started' && message !== 'busy') {
    if (form.window) params.set('window', form.window);
    if (form.range_from) params.set('range_from', form.range_from);
    if (form.range_to) params.set('range_to', form.range_to);
  }
  return `/?${params}`;
}

/**
 * POST /search — the dashboard's Run Search form (behind dashboard auth and the
 * CSRF check). Starts one Apify search on the server, with the Worker's Apify
 * token, then redirects (303) to the dashboard with a fixed message code, so a
 * reload never submits the search again. Logs carry only run ids.
 */
export function runSearchHandler(options: { fetch?: FetchLike; now?: () => Date } = {}) {
  return async (c: Context<AppEnv>) => {
    const body = await c.req.parseBody();
    const field = (name: string) => {
      const value = body[name];
      return typeof value === 'string' ? value : undefined;
    };
    const form: SearchForm = { window: field('window'), range_from: field('range_from'), range_to: field('range_to') };
    const redirect = (message: SearchMessage) => c.redirect(dashboardHref(message, form), 303);

    const { APIFY_TOKEN, APIFY_TASK_ID } = c.env;
    if (!APIFY_TOKEN || !APIFY_TASK_ID) {
      console.error('search: APIFY_TOKEN or APIFY_TASK_ID is not configured');
      return redirect('not_configured');
    }

    const now = options.now?.() ?? new Date();
    const parsed = parseSearchRequest(form, now, resolveTimeZone(c.env.DISPLAY_TIMEZONE));
    if (!parsed.ok) return redirect(parsed.error);

    try {
      const outcome = await startManualSearch(parsed.request, {
        db: c.env.DB,
        apify: createApifyClient(APIFY_TOKEN, options.fetch),
        taskId: APIFY_TASK_ID,
        now: options.now,
      });
      switch (outcome.kind) {
        case 'started':
          console.log(`search: started Apify run ${outcome.apifyRunId} (window ${parsed.request.window})`);
          return redirect('started');
        case 'busy':
          return redirect('busy');
        case 'failed':
          console.error(`search: not started: ${outcome.reason}`);
          return redirect('failed');
      }
    } catch (error) {
      console.error(`search: ${error instanceof Error ? error.name : 'error'} while starting a search`);
      return redirect('failed');
    }
  };
}
