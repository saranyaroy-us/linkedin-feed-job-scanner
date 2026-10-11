import type { Context } from 'hono';
import { createApifyClient, type FetchLike } from '../apify/client';
import type { AppEnv } from '../config/env';
import { SEARCH_QUERIES } from '../config/search-config';
import { dateInZone, resolveTimeZone, startOfDayUtc } from '../lib/time';
import { findSearchInFlight } from '../search/manual-search';
import { ClassificationsRepository } from '../storage/classifications.repository';
import { IngestRunsRepository } from '../storage/ingest-runs.repository';
import { PostsRepository } from '../storage/posts.repository';
import type { SearchRunWithIngest } from '../storage/search-runs.repository';
import { dashboardPage, type RunSearchViewModel } from '../views/dashboard';
import { rangeDays, searchWindowLabel } from '../views/search-window';
import {
  hasNoFilters,
  hasOnlyQueryFilter,
  parseFilters,
  parseIntParam,
  parseRelevanceView,
  withRelevance,
  withSearchWindow,
} from './filters';
import { parseSearchFormState } from './run-search';

export const DASHBOARD_PAGE_SIZE = 50;
const MAX_PAGE = 200;

/** GET / — Run Search, stats, posts per query and the filtered posts table (Relevant posts by default). */
export function dashboardHandler(options: { fetch?: FetchLike; now?: () => Date } = {}) {
  return async (c: Context<AppEnv>) => {
    const timeZone = resolveTimeZone(c.env.DISPLAY_TIMEZONE);
    const now = options.now?.() ?? new Date();
    const filters = parseFilters(c.req.query());
    const { filters: effective, windowFrom } = withSearchWindow(filters, now, timeZone);
    const page = parseIntParam(c.req.query('page'), 1, MAX_PAGE, 1);
    const view = parseRelevanceView(c.req.query('relevance'), 'relevant');

    const posts = new PostsRepository(c.env.DB);
    const runs = new IngestRunsRepository(c.env.DB);
    const apify = c.env.APIFY_TOKEN ? createApifyClient(c.env.APIFY_TOKEN, options.fetch) : null;

    const [perQuery, addedToday, latestRun, result, inFlight, relevanceCounts] = await Promise.all([
      posts.queryCounts(),
      posts.countCreatedSince(startOfDayUtc(dateInZone(now, timeZone), timeZone)),
      runs.latestScreened(),
      posts.search(withRelevance(effective, view), { limit: DASHBOARD_PAGE_SIZE, offset: (page - 1) * DASHBOARD_PAGE_SIZE, timeZone }),
      findSearchInFlight({ db: c.env.DB, apify, now: options.now }),
      new ClassificationsRepository(c.env.DB).counts(),
    ]);

    // Totals cover every stored post; the query filter and card list only the dashboard's queries.
    const countFor = (query: string | undefined) => perQuery.find((row) => row.search_query === query)?.posts ?? 0;
    const totalPosts = perQuery.reduce((sum, row) => sum + row.posts, 0);
    // Exact totals come from counter tables: per label for a relevance view, per query for "All".
    const viewTotal = view === 'all' ? totalPosts : relevanceCounts[view];
    const matching = hasNoFilters(filters)
      ? viewTotal
      : view === 'all' && hasOnlyQueryFilter(filters)
        ? countFor(filters.query)
        : null;

    return c.html(
      dashboardPage({
        timeZone,
        totalPosts,
        addedToday,
        latestRun,
        perQuery: SEARCH_QUERIES.map((query) => ({ search_query: query, posts: countFor(query) })),
        filters,
        view,
        relevanceCounts,
        searchWindowFrom: windowFrom,
        posts: result.posts,
        page,
        pageSize: DASHBOARD_PAGE_SIZE,
        hasMore: result.hasMore,
        matching,
        runSearch: runSearchModel(c.req.query(), inFlight, now, timeZone),
      }),
    );
  };
}

/** The Run Search card: while a search is in flight, its form shows that search's window. */
function runSearchModel(
  query: Record<string, string>,
  inFlight: SearchRunWithIngest | null,
  now: Date,
  timeZone: string,
): RunSearchViewModel {
  const form = parseSearchFormState(query);
  const today = dateInZone(now, timeZone);
  if (!inFlight) return { form, inFlight: null, today };
  const days = inFlight.search_window === 'range' ? rangeDays(inFlight, timeZone) : null;
  return {
    form: { ...form, window: inFlight.search_window, rangeFrom: days?.from ?? '', rangeTo: days?.to ?? '' },
    inFlight: {
      label: searchWindowLabel(inFlight, timeZone),
      progress:
        inFlight.status === 'starting' ? 'starting' : inFlight.ingest_status === 'processing' ? 'processing' : 'running',
      startedAt: inFlight.started_at,
    },
    today,
  };
}
