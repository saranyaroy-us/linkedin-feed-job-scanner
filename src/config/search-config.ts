import * as z from 'zod';

/** The only supported LinkedIn acquisition source. */
export const ACTOR_NAME = 'harvestapi/linkedin-post-search';

/**
 * Apify's immutable id for ACTOR_NAME. The webhook handler only ingests runs
 * whose `actId` matches, so a run of some other Actor can never be ingested.
 */
export const ACTOR_ID = 'buIWk2uOUzTmcLsuB';

/**
 * Actor input. Strict, so options we deliberately leave unset
 * (e.g. `contentType: "jobs"`) cannot creep in.
 */
export const SearchConfigSchema = z.strictObject({
  searchQueries: z.array(z.string().trim().min(1)).min(1),
  postedLimit: z.enum(['any', '1h', '24h', 'week', 'month', '3months', '6months', 'year']),
  sortBy: z.enum(['relevance', 'date']),
  // 0 means "unlimited" to the Actor, so require a positive cap.
  maxPosts: z.number().int().positive(),
  profileScraperMode: z.enum(['short', 'main']),
  scrapeReactions: z.literal(false),
  scrapeComments: z.literal(false),
  postNestedReactions: z.literal(false),
  postNestedComments: z.literal(false),
});

export type SearchConfig = z.infer<typeof SearchConfigSchema>;

export const SEARCH_QUERIES = [
  '"Revenue Operations" OR RevOps',
  '"Sales Operations" OR "Sales Ops"',
  '"Vendor Manager" OR "Vendor Management"',
] as const;

/**
 * Production input for the scheduled Apify Task (paste into the Task's input).
 * Broad on purpose: no "hiring" keyword and no contentType="jobs" — the future
 * job classifier decides what is an actual hiring post.
 * maxPosts is per query. LinkedIn returns only ~190–230 results per search, so
 * 600 means "everything available": in production that reached back 4.4 h
 * (Sales Ops), 6 h (Vendor) and 13.5 h (RevOps).
 */
export const PRODUCTION_SEARCH_CONFIG: SearchConfig = SearchConfigSchema.parse({
  searchQueries: [...SEARCH_QUERIES],
  maxPosts: 600,
  postedLimit: '24h',
  sortBy: 'date',
  profileScraperMode: 'short',
  scrapeReactions: false,
  scrapeComments: false,
  postNestedReactions: false,
  postNestedComments: false,
});

/** Apify schedule for the Task: 09:00 and 21:00 India time. */
export const SCHEDULE = { cron: '0 9,21 * * *', timezone: 'Asia/Kolkata' } as const;
