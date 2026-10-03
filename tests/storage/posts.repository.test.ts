import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RawPost } from '../../src/domain/raw-post';
import { normalizePosts } from '../../src/normalization/post-normalizer';
import { PostsRepository } from '../../src/storage/posts.repository';
import { CONTEXT, loadSampleItems, resetDb } from '../helpers';

const TZ = 'Asia/Kolkata';
const page = { limit: 50, offset: 0, timeZone: TZ };

let repo: PostsRepository;
let posts: RawPost[];

beforeEach(async () => {
  await resetDb();
  repo = new PostsRepository(env.DB);
  posts = (await normalizePosts(loadSampleItems(), CONTEXT)).posts;
});

describe('PostsRepository — D1 dedupe', () => {
  it('inserts new posts with every column and a created_at', async () => {
    expect(await repo.insertMany(posts)).toBe(6);
    const stored = await repo.findBySourceId('apify_linkedin_post_search', 'li:7500000000000000101');
    expect(stored).toMatchObject({ ...posts[0], id: expect.any(Number) });
    expect(stored?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(JSON.parse(stored!.raw_json!).repost.id).toBe('7500000000000000102');
  });

  it('never stores a duplicate (source, source_id); the first copy is kept unchanged', async () => {
    await repo.insertMany(posts);
    const changed = posts.map((p) => ({ ...p, text: 'changed', apify_run_id: 'OtherRun' }));
    expect(await repo.insertMany(changed)).toBe(0);
    const stored = await repo.findBySourceId('apify_linkedin_post_search', posts[0]!.source_id);
    expect(stored?.text).toBe(posts[0]!.text);
    expect(stored?.apify_run_id).toBe(CONTEXT.apifyRunId);
    const { n } = (await env.DB.prepare('SELECT COUNT(*) AS n FROM raw_posts').first<{ n: number }>())!;
    expect(n).toBe(6);
  });

  it('dedupes within one batch too', async () => {
    expect(await repo.insertMany([...posts, posts[0]!, posts[1]!])).toBe(6);
  });

  it('stores a repost and its original as two rows', async () => {
    const [repost] = loadSampleItems() as { repost: Record<string, unknown> }[];
    const { posts: both } = await normalizePosts([repost, repost!.repost], CONTEXT);
    expect(await repo.insertMany(both)).toBe(2);
  });

  it('rejects rows that violate a CHECK instead of silently skipping them', async () => {
    const bad = { ...posts[0]!, source: 'some_other_source' } as unknown as RawPost;
    await expect(repo.insertMany([bad])).rejects.toThrow();
  });

  it('splits very large inputs into several statements', async () => {
    const big = Array.from({ length: 300 }, (_, i) => ({
      ...posts[i % posts.length]!,
      source_id: `li:big${i}`,
      raw_json: JSON.stringify({ padding: 'x'.repeat(5000), i }),
    }));
    expect(repo.insertStatements(big).length).toBeGreaterThan(1);
    expect(await repo.insertMany(big)).toBe(300);
  });

  it('counts the posts first stored by a run', async () => {
    await repo.insertMany(posts);
    expect(await repo.countForRun(CONTEXT.apifyRunId)).toBe(6);
    expect(await repo.countForRun('NoSuchRun')).toBe(0);
  });
});

describe('PostsRepository — counters maintained by triggers', () => {
  it('keeps per-query totals in post_query_counts', async () => {
    await repo.insertMany(posts);
    await repo.insertMany(posts); // duplicates must not be counted again
    expect(await repo.queryCounts()).toEqual([
      { search_query: '"Sales Operations" OR "Sales Ops"', posts: 3 },
      { search_query: '"Vendor Manager" OR "Vendor Management"', posts: 2 },
      { search_query: '"Revenue Operations" OR RevOps', posts: 1 },
    ]);
  });

  it('counts posts without a search query under null and decrements on delete', async () => {
    await repo.insertMany([{ ...posts[0]!, search_query: null }]);
    expect(await repo.queryCounts()).toEqual([{ search_query: null, posts: 1 }]);
    await env.DB.prepare('DELETE FROM raw_posts').run();
    expect(await repo.queryCounts()).toEqual([]);
  });
});

describe('PostsRepository — dashboard queries', () => {
  beforeEach(async () => {
    await repo.insertMany(posts);
  });

  it('returns newest first without raw_json', async () => {
    const { posts: rows, hasMore } = await repo.search({}, page);
    expect(rows).toHaveLength(6);
    expect(hasMore).toBe(false);
    const times = rows.map((r) => r.posted_at!);
    expect(times).toEqual([...times].sort().reverse());
    expect(rows[0]).not.toHaveProperty('raw_json');
  });

  it('includes raw_json only when asked', async () => {
    const { posts: rows } = await repo.search({}, { ...page, includeRawJson: true });
    expect(typeof rows[0]!.raw_json).toBe('string');
  });

  it('filters by search query', async () => {
    const { posts: rows } = await repo.search({ query: '"Sales Operations" OR "Sales Ops"' }, page);
    expect(rows).toHaveLength(3);
  });

  it('filters by author (case-insensitive substring) and author type', async () => {
    expect((await repo.search({ author: 'AUTHOR five' }, page)).posts.map((p) => p.author_name)).toEqual([
      'Sample Author Five',
    ]);
    expect((await repo.search({ authorType: 'company' }, page)).posts.map((p) => p.author_name)).toEqual([
      'Example Data Co',
    ]);
  });

  it('filters by free text across text, headline and article title — longer than D1’s 50-byte LIKE limit', async () => {
    expect((await repo.search({ text: 'facility officer' }, page)).posts).toHaveLength(1);
    expect((await repo.search({ text: 'Product Marketing Manager' }, page)).posts).toHaveLength(1);
    const long = 'department is looking for driven individuals for a number of commercial roles';
    expect((await repo.search({ text: long }, page)).posts).toHaveLength(1);
    expect((await repo.search({ text: '%' }, page)).posts).toHaveLength(0); // no wildcard semantics
  });

  it('filters by date range in the display time zone', async () => {
    // Fixture posts are 2026-10-02 16:34–16:42 UTC = 2026-10-02 22:04–22:12 IST.
    expect((await repo.search({ from: '2026-10-02', to: '2026-10-02' }, page)).posts).toHaveLength(6);
    expect((await repo.search({ from: '2026-10-03' }, page)).posts).toHaveLength(0);
    expect((await repo.search({ to: '2026-10-01' }, page)).posts).toHaveLength(0);
    // In UTC+14 the same instants fall on 2026-10-03.
    expect((await repo.search({ from: '2026-10-03' }, { ...page, timeZone: 'Pacific/Kiritimati' })).posts).toHaveLength(6);
  });

  it('paginates with hasMore', async () => {
    const first = await repo.search({}, { ...page, limit: 4 });
    const second = await repo.search({}, { ...page, limit: 4, offset: 4 });
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(second.posts).toHaveLength(2);
    const ids = [...first.posts, ...second.posts].map((p) => p.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('counts posts created since a timestamp', async () => {
    expect(await repo.countCreatedSince('2000-01-01T00:00:00.000Z')).toBe(6);
    expect(await repo.countCreatedSince('2999-01-01T00:00:00.000Z')).toBe(0);
  });
});
