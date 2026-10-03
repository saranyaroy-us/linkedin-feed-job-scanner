import { describe, expect, it } from 'vitest';
import {
  ACTOR_ID,
  ACTOR_NAME,
  PRODUCTION_SEARCH_CONFIG,
  SCHEDULE,
  SearchConfigSchema,
} from '../../src/config/search-config';

describe('search config', () => {
  it('targets the only supported Actor', () => {
    expect(ACTOR_NAME).toBe('harvestapi/linkedin-post-search');
    expect(ACTOR_ID).toBe('buIWk2uOUzTmcLsuB');
  });

  it('is the agreed production input', () => {
    expect(PRODUCTION_SEARCH_CONFIG).toEqual({
      searchQueries: [
        '"Revenue Operations" OR RevOps',
        '"Sales Operations" OR "Sales Ops"',
        '"Vendor Manager" OR "Vendor Management"',
      ],
      maxPosts: 600,
      postedLimit: '24h',
      sortBy: 'date',
      profileScraperMode: 'short',
      scrapeReactions: false,
      scrapeComments: false,
      postNestedReactions: false,
      postNestedComments: false,
    });
  });

  it('keeps retrieval broad: no "hiring" keyword and no contentType', () => {
    expect(PRODUCTION_SEARCH_CONFIG.searchQueries.join(' ').toLowerCase()).not.toContain('hiring');
    expect(PRODUCTION_SEARCH_CONFIG).not.toHaveProperty('contentType');
    expect(SearchConfigSchema.safeParse({ ...PRODUCTION_SEARCH_CONFIG, contentType: 'jobs' }).success).toBe(false);
  });

  it('rejects maxPosts 0 (unlimited) and enabling reactions/comments', () => {
    expect(SearchConfigSchema.safeParse({ ...PRODUCTION_SEARCH_CONFIG, maxPosts: 0 }).success).toBe(false);
    expect(SearchConfigSchema.safeParse({ ...PRODUCTION_SEARCH_CONFIG, scrapeComments: true }).success).toBe(false);
  });

  it('is scheduled at 09:00 and 21:00 Asia/Kolkata', () => {
    expect(SCHEDULE).toEqual({ cron: '0 9,21 * * *', timezone: 'Asia/Kolkata' });
  });
});
