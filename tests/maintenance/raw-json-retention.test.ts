import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { RAW_JSON_RETENTION_DAYS } from '../../src/config/retention';
import type { StoredRawPostWithRaw } from '../../src/domain/raw-post';
import { clearExpiredRawJson } from '../../src/maintenance/raw-json-retention';
import { normalizePosts } from '../../src/normalization/post-normalizer';
import { PostsRepository } from '../../src/storage/posts.repository';
import worker from '../../src/worker';
import { asUsPosts, CONTEXT, loadSampleItems, manyItems, resetDb, testEnv } from '../helpers';

const DAY_MS = 24 * 60 * 60_000;
const RETENTION_MS = RAW_JSON_RETENTION_DAYS * DAY_MS;
const STORED_AT = '2026-10-01T00:00:00.000Z';
/** The time `ms` after STORED_AT. */
const storedAgo = (ms: number) => new Date(Date.parse(STORED_AT) + ms);

/** Inserts items through the real repository, then backdates their created_at. */
async function store(items: Record<string, unknown>[], createdAt: string) {
  const { posts } = await normalizePosts(items, CONTEXT);
  await new PostsRepository(env.DB).insertMany(asUsPosts(posts));
  await env.DB.prepare('UPDATE raw_posts SET created_at = ?1 WHERE source_id IN (SELECT value FROM json_each(?2))')
    .bind(createdAt, JSON.stringify(posts.map((p) => p.source_id)))
    .run();
  return posts.map((p) => p.source_id);
}

const rows = async () =>
  (await env.DB.prepare('SELECT * FROM raw_posts ORDER BY id').all<StoredRawPostWithRaw>()).results;
const rawJsonOf = async (sourceIds: string[]) =>
  (await rows()).filter((r) => sourceIds.includes(r.source_id)).map((r) => r.raw_json);
const counters = async () =>
  (await env.DB.prepare('SELECT search_query, posts FROM post_query_counts ORDER BY search_query').all()).results;

beforeEach(async () => {
  await resetDb();
});

describe('raw_json retention', () => {
  it('is 7 days', () => {
    expect(RAW_JSON_RETENTION_DAYS).toBe(7);
  });

  it('keeps raw_json while a post is 7 days old or younger', async () => {
    await store(loadSampleItems(), STORED_AT);
    for (const now of [storedAgo(DAY_MS), storedAgo(RETENTION_MS - 1), storedAgo(RETENTION_MS)]) {
      expect((await clearExpiredRawJson(env.DB, now)).cleared).toBe(0);
    }
    const stored = await rows();
    expect(stored).toHaveLength(6);
    for (const row of stored) expect(JSON.parse(row.raw_json!)).toHaveProperty('id');
  });

  it('sets raw_json to NULL once a post is older than 7 days', async () => {
    await store(loadSampleItems(), STORED_AT);
    const result = await clearExpiredRawJson(env.DB, storedAgo(RETENTION_MS + 1));
    expect(result).toMatchObject({ cutoff: '2026-10-01T00:00:00.001Z', cleared: 6 });
    expect((await rows()).map((r) => r.raw_json)).toEqual(Array(6).fill(null));
  });

  it('clears only posts past the cutoff; newer posts keep raw_json', async () => {
    const old = await store(manyItems(3, '71000000000'), '2026-09-20T00:00:00.000Z');
    const recent = await store(manyItems(2, '72000000000'), '2026-10-05T00:00:00.000Z');
    const result = await clearExpiredRawJson(env.DB, new Date('2026-10-08T12:00:00.000Z'));
    expect(result).toMatchObject({ cutoff: '2026-10-01T12:00:00.000Z', cleared: 3 });
    expect(await rawJsonOf(old)).toEqual([null, null, null]);
    expect((await rawJsonOf(recent)).every((raw) => typeof raw === 'string')).toBe(true);
  });

  it('keeps every row and every normalized field after raw_json is cleared', async () => {
    await store(loadSampleItems(), STORED_AT);
    const before = await rows();
    const countersBefore = await counters();

    await clearExpiredRawJson(env.DB, storedAgo(RETENTION_MS + 1));

    expect(await rows()).toEqual(before.map((row) => ({ ...row, raw_json: null })));
    expect(await counters()).toEqual(countersBefore);
    const repo = new PostsRepository(env.DB);
    const { posts } = await repo.search({}, { limit: 50, offset: 0, timeZone: 'Asia/Kolkata' });
    expect(posts).toHaveLength(6);
    const repost = await repo.findBySourceId('apify_linkedin_post_search', 'li:7500000000000000101');
    expect(repost).toMatchObject({ raw_json: null, repost_id: '7500000000000000102' });
    expect(repost?.text).toBeTruthy();
    expect(repost?.url).toMatch(/^https:\/\/www\.linkedin\.com\//);
  });

  it('is harmless to run again, or twice at the same time', async () => {
    await store(loadSampleItems(), STORED_AT);
    const now = storedAgo(RETENTION_MS + 1);
    expect((await clearExpiredRawJson(env.DB, now)).cleared).toBe(6);
    const once = await rows();
    const countersOnce = await counters();

    const [second, third] = await Promise.all([clearExpiredRawJson(env.DB, now), clearExpiredRawJson(env.DB, now)]);
    expect(second.cleared + third.cleared).toBe(0);
    expect((await clearExpiredRawJson(env.DB, storedAgo(RETENTION_MS * 10))).cleared).toBe(0);
    expect(await rows()).toEqual(once);
    expect(await counters()).toEqual(countersOnce);
  });

  it('clears in bounded batches, oldest first, so a backlog drains over later runs', async () => {
    const days = ['01', '02', '03', '04', '05'];
    const ids: string[][] = [];
    for (const [i, day] of days.entries()) ids.push(await store(manyItems(1, `7300000000${i}`), `2026-09-${day}T00:00:00.000Z`));
    const now = new Date('2026-10-01T00:00:00.000Z');

    expect((await clearExpiredRawJson(env.DB, now, 2)).cleared).toBe(2);
    expect(await rawJsonOf([...ids[0]!, ...ids[1]!])).toEqual([null, null]);
    expect((await rawJsonOf(ids[2]!))[0]).not.toBeNull();

    expect((await clearExpiredRawJson(env.DB, now, 2)).cleared).toBe(2);
    expect((await clearExpiredRawJson(env.DB, now, 2)).cleared).toBe(1);
    expect((await clearExpiredRawJson(env.DB, now, 2)).cleared).toBe(0);
    expect((await rows()).every((r) => r.raw_json === null)).toBe(true);
  });

  it('reads only posts that still have raw_json, not every expired post (partial index)', async () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    await store(manyItems(150, '74000000000'), '2026-09-01T00:00:00.000Z');
    expect((await clearExpiredRawJson(env.DB, now)).cleared).toBe(150);
    await store(manyItems(3, '75000000000'), '2026-09-02T00:00:00.000Z');

    const result = await clearExpiredRawJson(env.DB, now);
    expect(result.cleared).toBe(3);
    // Cost follows the posts cleared (~5 rows each locally), not the 153 expired
    // posts an index on created_at alone (or a table scan) would read.
    expect(result.rowsRead).toBeGreaterThan(0);
    expect(result.rowsRead).toBeLessThan(50);
  });

  it("runs from the Worker's scheduled (cron) handler", async () => {
    await store(loadSampleItems(), STORED_AT);
    const controller = {
      scheduledTime: storedAgo(RETENTION_MS + 1).getTime(),
      cron: '0 * * * *',
      noRetry: () => {},
    } as ScheduledController;
    await worker.scheduled(controller, testEnv());
    expect((await rows()).map((r) => r.raw_json)).toEqual(Array(6).fill(null));
  });
});
