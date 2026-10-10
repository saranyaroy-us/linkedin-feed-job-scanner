import { env } from 'cloudflare:workers';
import { fingerprint, type Manifest, type ResetDb } from '../scripts/legacy-reset/plan.mjs';
import { normalizePosts } from '../src/normalization/post-normalizer';
import { PostsRepository } from '../src/storage/posts.repository';
import { asUsPosts, FETCHED_AT, manyItems } from './helpers';

/**
 * A local copy of the production shape before the reset: four historical runs
 * (ingested before the hard filters: screened NULL, no job_country on their
 * posts) with pages and two searches, plus optionally newer US posts.
 */
export const LEGACY_RUNS = ['LegacyRunAaaaaaa1', 'LegacyRunBbbbbbb2', 'LegacyRunCcccccc3', 'LegacyRunDdddddd4'];
export const NEW_RUN = 'RunNewUs000000001';
export const LEGACY_QUERIES = ['"Revenue Operations" OR RevOps', '"Sales Operations" OR "Sales Ops"', '"Vendor Manager" OR "Vendor Management"'];
const LEGACY_INPUT = JSON.stringify({ searchQueries: LEGACY_QUERIES, postedLimit: '24h', sortBy: 'date', maxPosts: 600 });

export async function seedLegacyDataset(postsPerRun = 6): Promise<void> {
  const db = env.DB;
  for (const [i, runId] of LEGACY_RUNS.entries()) {
    const started = `2026-10-0${3 + Math.floor(i / 2)}T1${i}:00:00.000Z`;
    const run = await db
      .prepare(
        `INSERT INTO ingest_runs (started_at, completed_at, apify_run_id, dataset_id, query_config_json, fetched, new,
           already_seen, invalid, status, pages_total, page_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 'succeeded', 1, 25) RETURNING id`,
      )
      .bind(started, started.replace(':00:00.', ':05:00.'), runId, `Ds${runId}`, LEGACY_INPUT, postsPerRun + 1, postsPerRun)
      .first<{ id: number }>();
    await db.prepare('INSERT INTO ingest_run_pages (ingest_run_id, page_offset, fetched, invalid) VALUES (?, 0, ?, 0)').bind(run!.id, postsPerRun + 1).run();
    const items = manyItems(postsPerRun, `7510${i}000000`).map((item, k) => ({
      ...item,
      query: { ...(item.query as object), search: LEGACY_QUERIES[k % LEGACY_QUERIES.length] },
    }));
    const { posts } = await normalizePosts(items, { fetchedAt: FETCHED_AT, apifyRunId: runId });
    await new PostsRepository(db).insertMany(posts); // no job_country: stored before the US-job filter
  }
  for (const runId of LEGACY_RUNS.slice(2)) {
    await db
      .prepare(
        `INSERT INTO search_runs (search_window, requested_from, requested_to, apify_run_id, status, started_at)
         VALUES ('24h', '2026-10-04T00:00:00.000Z', '2026-10-05T00:00:00.000Z', ?, 'started', '2026-10-05T01:00:00.000Z')`,
      )
      .bind(runId)
      .run();
  }
}

/** Newer posts stored through the US-job filter by a screened run. */
export async function seedNewerUsPosts(count = 3, query = '"Sales Ops" AND "hiring"'): Promise<string[]> {
  await env.DB.prepare(
    `INSERT INTO ingest_runs (started_at, completed_at, apify_run_id, dataset_id, query_config_json, fetched, new, status,
       pages_total, page_size, screened)
     VALUES ('2026-10-10T09:00:00.000Z', '2026-10-10T09:05:00.000Z', ?, ?, '{}', ?, ?, 'succeeded', 1, 25, 1)`,
  )
    .bind(NEW_RUN, `Ds${NEW_RUN}`, count, count)
    .run();
  const items = manyItems(count, '75900000000').map((item) => ({ ...item, query: { ...(item.query as object), search: query } }));
  const { posts } = await normalizePosts(items, { fetchedAt: FETCHED_AT, apifyRunId: NEW_RUN });
  await new PostsRepository(env.DB).insertMany(asUsPosts(posts));
  return posts.map((post) => post.source_id);
}

/** The manifest an operator would approve for the seeded legacy posts. */
export async function legacyManifest(): Promise<Manifest> {
  const { results } = await env.DB.prepare(
    `SELECT id, source_id FROM raw_posts WHERE apify_run_id IN (${LEGACY_RUNS.map(() => '?').join(', ')}) ORDER BY id`,
  )
    .bind(...LEGACY_RUNS)
    .all<{ id: number; source_id: string }>();
  return {
    name: 'test-legacy-reset',
    runIds: [...LEGACY_RUNS],
    posts: results.length,
    minPostId: results[0]!.id,
    maxPostId: results.at(-1)!.id,
    sourceIdsSha256: await fingerprint(results.map((row) => row.source_id)),
  };
}

/** The reset plan against the local test D1 (batch = one transaction). */
export const localResetDb: ResetDb = {
  query: async (sql) => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results,
  run: async (statements) => {
    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
  },
};
