import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetStatements, runLegacyReset, scopeWhere, validateManifest, type Manifest } from '../../scripts/legacy-reset/plan.mjs';
import { resetDb } from '../helpers';
import { LEGACY_RUNS, legacyManifest, localResetDb, NEW_RUN, seedLegacyDataset, seedNewerUsPosts } from '../legacy-fixture';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const one = async <T>(sql: string) => (await env.DB.prepare(sql).first<T>())!;
const count = async (sql: string) => (await one<{ n: number }>(sql)).n;
const schema = async () =>
  (await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY name").all()).results;
const auditRecords = async () => ({
  runs: (await env.DB.prepare('SELECT * FROM ingest_runs ORDER BY id').all()).results,
  pages: (await env.DB.prepare('SELECT * FROM ingest_run_pages ORDER BY ingest_run_id, page_offset').all()).results,
  searches: (await env.DB.prepare('SELECT * FROM search_runs ORDER BY id').all()).results,
});
const execute = (manifest: Manifest, confirm = manifest.sourceIdsSha256.slice(0, 12)) =>
  runLegacyReset(localResetDb, manifest, { execute: true, confirm, now: NOW });

let manifest: Manifest;
let newer: string[];

beforeEach(async () => {
  await resetDb();
  await seedLegacyDataset();
  newer = await seedNewerUsPosts();
  manifest = await legacyManifest();
});

describe('legacy reset — dry run', () => {
  it('identifies exactly the legacy posts and changes nothing', async () => {
    const report = await runLegacyReset(localResetDb, manifest, { now: NOW });
    expect(report).toMatchObject({ state: 'ready', reasons: [], executed: false, after: null });
    expect(report.before).toMatchObject({ scopePosts: 24, legacyRowsOutsideScope: 0, otherPosts: 3, legacyRuns: 4 });
    expect(await count('SELECT COUNT(*) AS n FROM raw_posts')).toBe(27);
  });

  it('builds the deletion only from validated literals', () => {
    expect(validateManifest(manifest)).toEqual([]);
    expect(validateManifest({ ...manifest, runIds: ["x'); DROP TABLE raw_posts; --"] })).toContain('runIds must be Apify run ids');
    expect(scopeWhere(manifest)).toBe(
      `apify_run_id IN (${LEGACY_RUNS.map((id) => `'${id}'`).join(', ')}) AND id BETWEEN ${manifest.minPostId} AND ${manifest.maxPostId} AND job_country IS NULL`,
    );
    expect(scopeWhere(manifest, { hasJobCountry: false })).not.toContain('job_country');
    expect(resetStatements(manifest)).toEqual([`DELETE FROM raw_posts WHERE ${scopeWhere(manifest)}`, 'DELETE FROM post_query_counts WHERE posts <= 0']);
  });
});

describe('legacy reset — execution', () => {
  it('deletes only the legacy posts and keeps everything else', async () => {
    const schemaBefore = await schema();
    const auditBefore = await auditRecords();
    const report = await execute(manifest);

    expect(report).toMatchObject({ state: 'ready', executed: true, problems: [] });
    expect(report.after).toMatchObject({ scopePosts: 0, otherPosts: 3 });
    // Legacy posts (and their raw_json) are gone; newer US posts are untouched.
    expect(await count(`SELECT COUNT(*) AS n FROM raw_posts WHERE apify_run_id != '${NEW_RUN}'`)).toBe(0);
    expect((await env.DB.prepare('SELECT source_id FROM raw_posts ORDER BY source_id').all<{ source_id: string }>()).results.map((r) => r.source_id)).toEqual(
      [...newer].sort(),
    );
    // Per-query counts match the posts left; the legacy queries are gone, nothing is zero or orphaned.
    expect((await env.DB.prepare('SELECT search_query, posts FROM post_query_counts').all()).results).toEqual([
      { search_query: '"Sales Ops" AND "hiring"', posts: 3 },
    ]);
    // Ingestion history and the schema are unchanged.
    expect(await auditRecords()).toEqual(auditBefore);
    expect(await schema()).toEqual(schemaBefore);
    expect(
      await count('SELECT COUNT(*) AS n FROM ingest_run_pages p WHERE NOT EXISTS (SELECT 1 FROM ingest_runs r WHERE r.id = p.ingest_run_id)'),
    ).toBe(0);
  });

  it('can be run again: a second run finds nothing to delete and changes nothing', async () => {
    await execute(manifest);
    const snapshot = { posts: await count('SELECT COUNT(*) AS n FROM raw_posts'), audit: await auditRecords() };
    expect((await runLegacyReset(localResetDb, manifest, { now: NOW })).state).toBe('done');
    const again = await execute(manifest);
    expect(again).toMatchObject({ state: 'done', executed: true, problems: [] });
    expect({ posts: await count('SELECT COUNT(*) AS n FROM raw_posts'), audit: await auditRecords() }).toEqual(snapshot);
  });

  it('needs the confirmation code to execute', async () => {
    for (const confirm of [undefined, 'wrong', manifest.sourceIdsSha256.slice(0, 11)]) {
      const report = await runLegacyReset(localResetDb, manifest, { execute: true, confirm, now: NOW });
      expect(report).toMatchObject({ state: 'blocked', executed: false });
    }
    expect(await count('SELECT COUNT(*) AS n FROM raw_posts')).toBe(27);
  });
});

describe('legacy reset — blocked when the database differs from the approved plan', () => {
  const blocked = async (m: Manifest, reason: RegExp) => {
    const report = await execute(m);
    expect(report.state).toBe('blocked');
    expect(report.executed).toBe(false);
    expect(report.reasons.join('\n')).toMatch(reason);
    expect(await count('SELECT COUNT(*) AS n FROM raw_posts')).toBe(27);
  };

  it('a different post count, id range or fingerprint', async () => {
    await blocked({ ...manifest, posts: manifest.posts + 1 }, /scope has 24 posts, the manifest approves 25/);
    await blocked({ ...manifest, maxPostId: manifest.maxPostId - 1 }, /outside the approved id range/);
    await blocked({ ...manifest, sourceIdsSha256: '0'.repeat(64) }, /differ from the manifest fingerprint/);
  });

  it('a post of a legacy run that is not part of the plan (e.g. a newer US post)', async () => {
    await env.DB.prepare(`UPDATE raw_posts SET job_country = 'US' WHERE id = ${manifest.minPostId}`).run();
    await blocked(manifest, /fall outside the approved id range or have a job_country/);
  });

  it('a missing legacy run record', async () => {
    await blocked({ ...manifest, runIds: [...LEGACY_RUNS.slice(0, 3), 'LegacyRunMissing01'] }, /expected 4 legacy ingest runs, found 3/);
  });

  it('ingestion in progress', async () => {
    await env.DB.prepare(`UPDATE ingest_runs SET status = 'processing' WHERE apify_run_id = '${NEW_RUN}'`).run();
    await blocked(manifest, /ingest run\(s\) still processing/);
    await env.DB.prepare(`UPDATE ingest_runs SET status = 'succeeded' WHERE apify_run_id = '${NEW_RUN}'`).run();
    await env.DB.prepare(
      `INSERT INTO search_runs (search_window, requested_from, requested_to, status, started_at)
       VALUES ('24h', '2026-10-09T12:00:00.000Z', '2026-10-10T12:00:00.000Z', 'starting', '2026-10-10T11:59:00.000Z')`,
    ).run();
    await blocked(manifest, /search\(es\) in flight/);
  });
});
