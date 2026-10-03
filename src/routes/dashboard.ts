import type { Context } from 'hono';
import type { AppEnv } from '../config/env';
import { dateInZone, resolveTimeZone, startOfDayUtc } from '../lib/time';
import { IngestRunsRepository } from '../storage/ingest-runs.repository';
import { PostsRepository } from '../storage/posts.repository';
import { dashboardPage } from '../views/dashboard';
import { hasNoFilters, hasOnlyQueryFilter, parseFilters, parseIntParam, withSearchWindow } from './filters';

export const DASHBOARD_PAGE_SIZE = 50;
const MAX_PAGE = 200;

/** GET / — stats, posts per query and the filtered posts table. */
export function dashboardHandler(options: { now?: () => Date } = {}) {
  return async (c: Context<AppEnv>) => {
    const timeZone = resolveTimeZone(c.env.DISPLAY_TIMEZONE);
    const now = options.now?.() ?? new Date();
    const filters = parseFilters(c.req.query());
    const { filters: effective, windowFrom } = withSearchWindow(filters, now, timeZone);
    const page = parseIntParam(c.req.query('page'), 1, MAX_PAGE, 1);

    const posts = new PostsRepository(c.env.DB);
    const runs = new IngestRunsRepository(c.env.DB);

    const [perQuery, addedToday, latestRun, result] = await Promise.all([
      posts.queryCounts(),
      posts.countCreatedSince(startOfDayUtc(dateInZone(now, timeZone), timeZone)),
      runs.latest(),
      posts.search(effective, { limit: DASHBOARD_PAGE_SIZE, offset: (page - 1) * DASHBOARD_PAGE_SIZE, timeZone }),
    ]);

    const totalPosts = perQuery.reduce((sum, row) => sum + row.posts, 0);
    const matching = hasNoFilters(filters)
      ? totalPosts
      : hasOnlyQueryFilter(filters)
        ? (perQuery.find((row) => row.search_query === filters.query)?.posts ?? 0)
        : null;

    return c.html(
      dashboardPage({
        timeZone,
        totalPosts,
        addedToday,
        latestRun,
        perQuery,
        filters,
        searchWindowFrom: windowFrom,
        posts: result.posts,
        page,
        pageSize: DASHBOARD_PAGE_SIZE,
        hasMore: result.hasMore,
        matching,
      }),
    );
  };
}
