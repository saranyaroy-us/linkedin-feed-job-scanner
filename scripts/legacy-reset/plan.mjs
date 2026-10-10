/**
 * One-time reset of the legacy posts: the posts stored by the ingestion runs
 * made before the hiring and US-job filters. Plain ES module with no Node
 * imports, so the same checks run in tests (local D1 binding) and in the
 * operator CLI (wrangler d1 execute, see ./cli.mjs).
 *
 * Safety:
 *   - The scope is fixed by a manifest: the legacy run ids, the expected post
 *     count, the post-id range and a SHA-256 of the exact sorted source ids.
 *     Rows must also have no job_country (every post stored since the US-job
 *     filter has 'US').
 *   - Before anything is deleted the database must match the manifest exactly
 *     and no ingestion may be in flight; otherwise the plan is "blocked".
 *   - Deletion is one DELETE statement (atomic, including the trigger that
 *     keeps post_query_counts in step), then zero-count rows are dropped. Both
 *     are idempotent: after a partial failure, running again finishes the job
 *     ("done" state). Ingestion history (ingest_runs, ingest_run_pages,
 *     search_runs), the schema and all newer posts are never touched.
 * Output is counts only — never post content.
 */

/** @typedef {{ name: string, runIds: string[], posts: number, minPostId: number, maxPostId: number, sourceIdsSha256: string }} Manifest */

const RUN_ID = /^[A-Za-z0-9]{6,32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A search is in flight for at most this long (src/search/manual-search.ts SEARCH_TIMEOUT_MS). */
const SEARCH_TIMEOUT_MS = 30 * 60_000;

/** @param {Manifest} manifest */
export function validateManifest(manifest) {
  const problems = [];
  if (!Array.isArray(manifest.runIds) || manifest.runIds.length === 0) problems.push('runIds must list the legacy runs');
  else if (!manifest.runIds.every((id) => RUN_ID.test(id))) problems.push('runIds must be Apify run ids');
  for (const key of ['posts', 'minPostId', 'maxPostId']) {
    if (!Number.isInteger(manifest[key]) || manifest[key] < 0) problems.push(`${key} must be a non-negative integer`);
  }
  if (manifest.minPostId > manifest.maxPostId) problems.push('minPostId must not exceed maxPostId');
  if (!SHA256.test(manifest.sourceIdsSha256 ?? '')) problems.push('sourceIdsSha256 must be a SHA-256 hex digest');
  return problems;
}

const runList = (manifest) => manifest.runIds.map((id) => `'${id}'`).join(', ');

/** The rows the manifest approves for deletion (literals only: run ids are validated above). */
export function scopeWhere(manifest, { hasJobCountry = true } = {}) {
  return [
    `apify_run_id IN (${runList(manifest)})`,
    `id BETWEEN ${manifest.minPostId} AND ${manifest.maxPostId}`,
    ...(hasJobCountry ? ['job_country IS NULL'] : []),
  ].join(' AND ');
}

/** SHA-256 hex of the sorted source ids, one per line. */
export async function fingerprint(sourceIds) {
  const bytes = new TextEncoder().encode([...sourceIds].sort().join('\n'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read-only snapshot of everything the plan checks.
 * @param {{ query: (sql: string) => Promise<Record<string, unknown>[]> }} db
 * @param {Manifest} manifest
 * @param {Date} now
 */
export async function inspect(db, manifest, now) {
  const columns = await db.query('PRAGMA table_info(raw_posts)');
  const hasJobCountry = columns.some((column) => column.name === 'job_country');
  const scope = scopeWhere(manifest, { hasJobCountry });
  const runs = runList(manifest);
  const scoped = await db.query(`SELECT id, source_id FROM raw_posts WHERE ${scope} ORDER BY id`);
  const [outside] = await db.query(`SELECT COUNT(*) AS n FROM raw_posts WHERE apify_run_id IN (${runs}) AND NOT (${scope})`);
  const [others] = await db.query(
    `SELECT COUNT(*) AS n FROM raw_posts WHERE apify_run_id IS NULL OR apify_run_id NOT IN (${runs})`,
  );
  const legacyRuns = await db.query(
    `SELECT apify_run_id, status, fetched, new, already_seen, invalid, out_of_range FROM ingest_runs
     WHERE apify_run_id IN (${runs}) ORDER BY apify_run_id`,
  );
  const [processing] = await db.query(`SELECT COUNT(*) AS n FROM ingest_runs WHERE status = 'processing'`);
  const since = new Date(now.getTime() - SEARCH_TIMEOUT_MS).toISOString();
  const [searching] = await db.query(
    `SELECT COUNT(*) AS n FROM search_runs s
     WHERE s.status = 'starting'
        OR (s.status = 'started' AND s.started_at > '${since}' AND NOT EXISTS (
             SELECT 1 FROM ingest_runs r WHERE r.apify_run_id = s.apify_run_id AND r.status IN ('succeeded', 'failed')))`,
  );
  const [totals] = await db.query(
    `SELECT (SELECT COUNT(*) FROM raw_posts) AS posts,
            (SELECT COUNT(*) FROM ingest_runs) AS ingest_runs,
            (SELECT COUNT(*) FROM ingest_run_pages) AS ingest_run_pages,
            (SELECT COUNT(*) FROM search_runs) AS search_runs,
            (SELECT COALESCE(SUM(posts), 0) FROM post_query_counts) AS counted_posts`,
  );
  const schema = await db.query(`SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name`);
  const [counterMismatches] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM post_query_counts c
         WHERE c.posts != (SELECT COUNT(*) FROM raw_posts p WHERE COALESCE(p.search_query, '') = c.search_query)) AS wrong_counts,
       (SELECT COUNT(*) FROM (SELECT DISTINCT COALESCE(search_query, '') AS q FROM raw_posts) a
         WHERE NOT EXISTS (SELECT 1 FROM post_query_counts c WHERE c.search_query = a.q)) AS missing_counts,
       (SELECT COUNT(*) FROM post_query_counts WHERE posts <= 0) AS empty_counts,
       (SELECT COUNT(*) FROM ingest_run_pages p WHERE NOT EXISTS (SELECT 1 FROM ingest_runs r WHERE r.id = p.ingest_run_id)) AS orphan_pages`,
  );
  return {
    hasJobCountry,
    scope: {
      posts: scoped.length,
      minPostId: scoped.length ? Number(scoped[0].id) : null,
      maxPostId: scoped.length ? Number(scoped.at(-1).id) : null,
      sourceIdsSha256: await fingerprint(scoped.map((row) => String(row.source_id))),
    },
    legacyRowsOutsideScope: Number(outside.n),
    otherPosts: Number(others.n),
    legacyRuns,
    activeIngestion: { processingRuns: Number(processing.n), searchesInFlight: Number(searching.n) },
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v)])),
    schema: schema.map((row) => `${row.type}:${row.name}`),
    consistency: Object.fromEntries(Object.entries(counterMismatches).map(([k, v]) => [k, Number(v)])),
  };
}

/**
 * "ready" (database matches the manifest), "done" (already deleted) or "blocked".
 * @param {Awaited<ReturnType<typeof inspect>>} snapshot
 * @param {Manifest} manifest
 */
export function evaluate(snapshot, manifest) {
  const reasons = [...validateManifest(manifest)];
  const { scope } = snapshot;
  if (snapshot.activeIngestion.processingRuns > 0) reasons.push(`${snapshot.activeIngestion.processingRuns} ingest run(s) still processing`);
  if (snapshot.activeIngestion.searchesInFlight > 0) reasons.push(`${snapshot.activeIngestion.searchesInFlight} search(es) in flight`);
  if (snapshot.legacyRuns.length !== manifest.runIds.length) {
    reasons.push(`expected ${manifest.runIds.length} legacy ingest runs, found ${snapshot.legacyRuns.length}`);
  }
  if (snapshot.legacyRuns.some((run) => run.status !== 'succeeded')) reasons.push('a legacy ingest run is not "succeeded"');
  if (snapshot.legacyRowsOutsideScope > 0) {
    reasons.push(`${snapshot.legacyRowsOutsideScope} post(s) of the legacy runs fall outside the approved id range or have a job_country`);
  }
  const done = scope.posts === 0;
  if (!done) {
    if (scope.posts !== manifest.posts) reasons.push(`scope has ${scope.posts} posts, the manifest approves ${manifest.posts}`);
    if (scope.minPostId !== manifest.minPostId || scope.maxPostId !== manifest.maxPostId) {
      reasons.push(`scope ids ${scope.minPostId}–${scope.maxPostId} differ from the manifest's ${manifest.minPostId}–${manifest.maxPostId}`);
    }
    if (scope.sourceIdsSha256 !== manifest.sourceIdsSha256) reasons.push('scope source ids differ from the manifest fingerprint');
  }
  return { state: reasons.length ? 'blocked' : done ? 'done' : 'ready', reasons };
}

/** The deletion, in order. Each statement is atomic and idempotent. */
export function resetStatements(manifest, { hasJobCountry = true } = {}) {
  return [
    // The AFTER DELETE trigger decrements post_query_counts for every row, inside this statement.
    `DELETE FROM raw_posts WHERE ${scopeWhere(manifest, { hasJobCountry })}`,
    // Queries left with no posts (the legacy search queries) leave the per-query table.
    'DELETE FROM post_query_counts WHERE posts <= 0',
  ];
}

/**
 * Compares snapshots taken before and after the reset.
 * @param {Awaited<ReturnType<typeof inspect>>} before
 * @param {Awaited<ReturnType<typeof inspect>>} after
 */
export function verify(before, after) {
  const problems = [];
  if (after.scope.posts !== 0) problems.push(`${after.scope.posts} legacy post(s) remain`);
  if (after.legacyRowsOutsideScope !== 0) problems.push(`${after.legacyRowsOutsideScope} other post(s) of the legacy runs remain`);
  if (after.otherPosts !== before.otherPosts) problems.push(`newer posts changed: ${before.otherPosts} → ${after.otherPosts}`);
  if (after.totals.posts !== before.totals.posts - before.scope.posts) problems.push('total posts did not drop by exactly the scope');
  for (const table of ['ingest_runs', 'ingest_run_pages', 'search_runs']) {
    if (after.totals[table] !== before.totals[table]) problems.push(`${table} changed: ${before.totals[table]} → ${after.totals[table]}`);
  }
  if (JSON.stringify(after.legacyRuns) !== JSON.stringify(before.legacyRuns)) problems.push('legacy run audit records changed');
  if (JSON.stringify(after.schema) !== JSON.stringify(before.schema)) problems.push('schema changed');
  if (after.totals.counted_posts !== after.totals.posts) {
    problems.push(`post_query_counts total ${after.totals.counted_posts} differs from ${after.totals.posts} stored posts`);
  }
  for (const [check, count] of Object.entries(after.consistency)) if (count !== 0) problems.push(`${check}: ${count}`);
  return problems;
}

/**
 * Inspects, and with `execute` deletes and verifies.
 * @param {{ query: (sql: string) => Promise<Record<string, unknown>[]>, run: (statements: string[]) => Promise<void> }} db
 * @param {Manifest} manifest
 * @param {{ execute?: boolean, confirm?: string, now?: Date }} options
 */
export async function runLegacyReset(db, manifest, options = {}) {
  const now = options.now ?? new Date();
  const before = await inspect(db, manifest, now);
  const plan = evaluate(before, manifest);
  const report = { manifest: manifest.name, state: plan.state, reasons: plan.reasons, before: summarize(before), executed: false, after: null, problems: [] };
  if (!options.execute || plan.state === 'blocked') return report;
  if (options.confirm !== manifest.sourceIdsSha256.slice(0, 12)) {
    return { ...report, state: 'blocked', reasons: ['execution needs --confirm=<first 12 characters of sourceIdsSha256>'] };
  }
  await db.run(resetStatements(manifest, { hasJobCountry: before.hasJobCountry }));
  const after = await inspect(db, manifest, now);
  return { ...report, executed: true, after: summarize(after), problems: verify(before, after) };
}

/** Counts only, for printing. */
function summarize(snapshot) {
  return {
    scopePosts: snapshot.scope.posts,
    scopeIds: snapshot.scope.posts ? `${snapshot.scope.minPostId}–${snapshot.scope.maxPostId}` : null,
    scopeFingerprintPrefix: snapshot.scope.sourceIdsSha256.slice(0, 12),
    legacyRowsOutsideScope: snapshot.legacyRowsOutsideScope,
    otherPosts: snapshot.otherPosts,
    legacyRuns: snapshot.legacyRuns.length,
    activeIngestion: snapshot.activeIngestion,
    totals: snapshot.totals,
    consistency: snapshot.consistency,
  };
}
