import * as z from 'zod';

/** The only supported LinkedIn acquisition source. */
export const ACTOR_NAME = 'harvestapi/linkedin-post-search';

/**
 * Apify's immutable id for ACTOR_NAME. The webhook handler only ingests runs
 * whose `actId` matches, so a run of some other Actor can never be ingested.
 */
export const ACTOR_ID = 'buIWk2uOUzTmcLsuB';

/**
 * Actor input. Strict, so options we deliberately leave unset cannot creep in,
 * and contentType can only be "all" (never "jobs").
 */
export const SearchConfigSchema = z.strictObject({
  searchQueries: z.array(z.string().trim().min(1)).min(1),
  postedLimit: z.enum(['any', '1h', '24h', 'week', 'month', '3months', '6months', 'year']),
  // The Actor's historical cutoff: posts from now back to this instant. Only a
  // date-range search sets it (with postedLimit "any").
  postedLimitDate: z.iso.datetime().optional(),
  sortBy: z.enum(['relevance', 'date']),
  // Every kind of post; never "jobs" (job-card-only posts).
  contentType: z.literal('all'),
  // 0 means "unlimited" to the Actor, so require a positive cap.
  maxPosts: z.number().int().positive(),
  profileScraperMode: z.enum(['short', 'main']),
  scrapeReactions: z.literal(false),
  scrapeComments: z.literal(false),
  postNestedReactions: z.literal(false),
  postNestedComments: z.literal(false),
});

export type SearchConfig = z.infer<typeof SearchConfigSchema>;

/**
 * The production search queries, in this order. The dashboard's "Search query"
 * filter and "Posts per search query" list exactly these; posts stored under
 * any other query value (earlier searches) stay in D1 and in the posts table.
 */
export const SEARCH_QUERIES = [
  '"Revenue Operations" AND "hiring"',
  '"Revenue Operation" AND "hiring"',
  '"Sales Operations" AND "hiring"',
  '"Sales Operation" AND "hiring"',
  '"Sales Ops" AND "hiring"',
  '"Vendor Manager" AND "hiring"',
  '"Vendor Management" AND "hiring"',
] as const;

/**
 * Every stored post must contain this word. The queries ask LinkedIn for it,
 * but LinkedIn matches loosely, so ingestion enforces it as a hard filter
 * (src/ingestion/hiring-filter.ts) before any post is normalized or stored.
 */
export const REQUIRED_KEYWORD = 'hiring';

/**
 * Production input for every search. The dashboard's Run Search starts the
 * Apify Task with this input plus the chosen window as a one-run override, so
 * the Task's stored input is never changed.
 * contentType "all", never "jobs": the hard filters and the future job
 * classifier decide which posts are actual vacancies.
 * maxPosts is per query. LinkedIn returns only ~190–230 results per search, so
 * 600 means "everything available" (the earlier, broader OR queries reached
 * back only 4.4–13.5 h; these narrower queries should cover more).
 */
export const PRODUCTION_SEARCH_CONFIG: SearchConfig = SearchConfigSchema.parse({
  searchQueries: [...SEARCH_QUERIES],
  maxPosts: 600,
  postedLimit: '24h',
  sortBy: 'date',
  contentType: 'all',
  profileScraperMode: 'short',
  scrapeReactions: false,
  scrapeComments: false,
  postNestedReactions: false,
  postNestedComments: false,
});

/**
 * postedLimit for each relative Run Search window. A date range instead sets
 * postedLimit "any" plus postedLimitDate, and ingestion keeps only the posts
 * posted inside the range.
 */
export const WINDOW_POSTED_LIMIT = {
  '24h': '24h',
  week: 'week',
  month: 'month',
} as const satisfies Record<string, SearchConfig['postedLimit']>;
