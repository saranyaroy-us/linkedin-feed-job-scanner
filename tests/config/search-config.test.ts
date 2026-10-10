import { describe, expect, it } from 'vitest';
import taskInput from '../../scripts/apify-task/task-input.json';
import * as searchConfig from '../../src/config/search-config';
import {
  ACTOR_ID,
  ACTOR_NAME,
  PRODUCTION_SEARCH_CONFIG,
  REQUIRED_KEYWORD,
  SEARCH_QUERIES,
  SearchConfigSchema,
  WINDOW_POSTED_LIMIT,
} from '../../src/config/search-config';

describe('search config', () => {
  it('targets the only supported Actor', () => {
    expect(ACTOR_NAME).toBe('harvestapi/linkedin-post-search');
    expect(ACTOR_ID).toBe('buIWk2uOUzTmcLsuB');
  });

  it('is the agreed production input', () => {
    expect(PRODUCTION_SEARCH_CONFIG).toEqual({
      searchQueries: [
        '"Revenue Operations" AND "hiring"',
        '"Revenue Operation" AND "hiring"',
        '"Sales Operations" AND "hiring"',
        '"Sales Operation" AND "hiring"',
        '"Sales Ops" AND "hiring"',
        '"Vendor Manager" AND "hiring"',
        '"Vendor Management" AND "hiring"',
      ],
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
  });

  it('keeps contentType "all" and never accepts "jobs"', () => {
    expect(PRODUCTION_SEARCH_CONFIG.contentType).toBe('all');
    expect(SearchConfigSchema.safeParse({ ...PRODUCTION_SEARCH_CONFIG, contentType: 'jobs' }).success).toBe(false);
  });

  it('rejects maxPosts 0 (unlimited) and enabling reactions/comments', () => {
    expect(SearchConfigSchema.safeParse({ ...PRODUCTION_SEARCH_CONFIG, maxPosts: 0 }).success).toBe(false);
    expect(SearchConfigSchema.safeParse({ ...PRODUCTION_SEARCH_CONFIG, scrapeComments: true }).success).toBe(false);
  });

  it('runs exactly the seven production queries, each requiring a quoted "hiring"', () => {
    expect(SEARCH_QUERIES).toHaveLength(7);
    for (const query of SEARCH_QUERIES) expect(query).toMatch(/^"[^"]+" AND "hiring"$/);
    expect(REQUIRED_KEYWORD).toBe('hiring');
  });

  it('mirrors the production input in the saved Apify Task input (scripts/apify-task/task-input.json)', () => {
    expect(taskInput).toEqual(PRODUCTION_SEARCH_CONFIG);
  });

  it('maps the Run Search windows to the Actor postedLimit values', () => {
    expect(WINDOW_POSTED_LIMIT).toEqual({ '24h': '24h', week: 'week', month: 'month' });
  });

  it('accepts only an ISO instant as the historical cutoff (postedLimitDate)', () => {
    const range = { ...PRODUCTION_SEARCH_CONFIG, postedLimit: 'any', postedLimitDate: '2026-09-30T18:30:00.000Z' };
    expect(SearchConfigSchema.safeParse(range).success).toBe(true);
    expect(SearchConfigSchema.safeParse({ ...range, postedLimitDate: 'last week' }).success).toBe(false);
  });

  it('defines no job-search schedule: every search is started from the dashboard', () => {
    expect(Object.keys(searchConfig)).not.toContain('SCHEDULE');
  });
});
