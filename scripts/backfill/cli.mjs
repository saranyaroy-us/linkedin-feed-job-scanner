#!/usr/bin/env node
/**
 * Operator CLI for the job-detail and relevance backfill (src/maintenance/backfill.ts).
 * Dry run by default: reads the stored US posts, prints the plan's counts and changes nothing.
 *
 *   node scripts/backfill/cli.mjs --remote                      # dry run against production D1 (read-only)
 *   node scripts/backfill/cli.mjs --local [--persist-to <dir>]  # dry run against a local D1
 *   node scripts/backfill/cli.mjs ... --show                    # also list each post's changes (titles, employers, labels)
 *   node scripts/backfill/cli.mjs --remote --execute --confirm=<first 12 characters of the plan fingerprint>
 *
 * Execution needs migration 0008, no ingestion in progress, and the confirm code of the very plan it runs
 * (if the database changed since the dry run, the plan and its code change too). After executing it plans
 * again and expects nothing left to do. Prints counts, job titles, employers and labels — never post text.
 * The app's TypeScript is bundled on the fly with the esbuild that the dev dependencies already install.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D1_DATABASE } from '../project.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (flag('--remote') === flag('--local')) {
  console.error('Choose exactly one of --remote or --local [--persist-to <dir>].');
  process.exit(2);
}
const target = flag('--remote') ? ['--remote'] : ['--local', ...(option('--persist-to') ? ['--persist-to', option('--persist-to')] : [])];
const execute = flag('--execute');
const WRANGLER = fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url));

function wrangler(extra, attempts = 1) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', D1_DATABASE, ...target, ...extra], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch (error) {
      // Reads are retried (D1's API sometimes answers 7403 once); writes never are — re-run the CLI instead.
      if (attempt >= attempts) throw new Error(`wrangler d1 execute failed: ${String(error.stdout ?? error.message).match(/"text":\s*"([^"]+)"/)?.[1] ?? 'see wrangler output'}`);
    }
  }
}
const query = (sql) => {
  const out = wrangler(['--json', '--command', sql], 3);
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
};

const work = mkdtempSync(join(tmpdir(), 'backfill-'));
let exitCode = 0;
try {
  await build({
    entryPoints: [fileURLToPath(new URL('../../src/maintenance/backfill.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(work, 'backfill.mjs'),
    logLevel: 'warning',
  });
  const { BACKFILL_SELECT, BACKFILL_SELECT_BEFORE_0008, planBackfill, planFingerprint } = await import(pathToFileURL(join(work, 'backfill.mjs')).href);

  const migrated =
    query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'post_classifications'`).length === 1 &&
    query('PRAGMA table_info(raw_posts)').some((column) => column.name === 'job_title_source');
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const [activity] = query(
    `SELECT (SELECT COUNT(*) FROM ingest_runs WHERE status = 'processing') AS processing_runs,
            (SELECT COUNT(*) FROM search_runs s WHERE s.status = 'starting'
               OR (s.status = 'started' AND s.started_at > '${since}' AND NOT EXISTS (
                    SELECT 1 FROM ingest_runs r WHERE r.apify_run_id = s.apify_run_id AND r.status IN ('succeeded', 'failed')))) AS searches_in_flight`,
  );
  const plan = () => planBackfill(query(migrated ? BACKFILL_SELECT : BACKFILL_SELECT_BEFORE_0008));
  const planned = plan();
  const confirm = (await planFingerprint(planned.statements)).slice(0, 12);

  const reasons = [];
  if (!migrated) reasons.push('migration 0008 is not applied (dry run only)');
  if (activity.processing_runs > 0) reasons.push(`${activity.processing_runs} ingest run(s) processing`);
  if (activity.searches_in_flight > 0) reasons.push(`${activity.searches_in_flight} search(es) in flight`);
  if (execute && option('--confirm') !== confirm) reasons.push('--confirm does not match this plan');

  const report = {
    target: target.join(' '),
    mode: execute ? 'execute' : 'dry-run',
    migration0008: migrated,
    activity,
    posts: planned.posts,
    postsWithRawJson: planned.summary.postsWithRawJson,
    postsChanged: planned.changes.length,
    detailChanges: planned.summary.detailChanges,
    classify: planned.summary.classify,
    relevanceBefore: planned.summary.relevanceBefore,
    relevanceAfter: planned.summary.relevanceAfter,
    statements: planned.statements.length,
    confirm,
    reasons,
    executed: false,
  };

  if (flag('--show')) {
    for (const change of planned.changes) {
      const c = change.classification;
      const fields = Object.entries(change.fields).map(([field, v]) => `${field}: ${v.from ?? '—'} → ${v.to ?? '—'}`);
      console.log(
        `#${change.id}  ${change.previousRelevance ?? 'unclassified'} → ${c ? `${c.relevance} (${c.persona})` : 'unchanged'}` +
          `${c?.evidence_text ? `  “${c.evidence_text}”` : ''}${fields.length ? `\n      ${fields.join('\n      ')}` : ''}`,
      );
    }
  }

  if (execute && reasons.length === 0 && planned.statements.length) {
    const file = join(work, 'backfill.sql');
    writeFileSync(file, planned.statements.join('\n') + '\n');
    wrangler(['--file', file]);
    const after = plan();
    Object.assign(report, { executed: true, remainingChanges: after.changes.length, verified: after.changes.length === 0 });
  }
  console.log(JSON.stringify(report, null, 2));
  exitCode = execute && (reasons.length || report.verified === false) ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
