#!/usr/bin/env node
/**
 * Operator CLI for the one-time legacy reset (see ./plan.mjs and README "Legacy reset").
 * Dry run by default: inspects and reports counts, changes nothing.
 *
 *   node scripts/legacy-reset/cli.mjs --remote                      # dry run against production D1
 *   node scripts/legacy-reset/cli.mjs --local --persist-to <dir>    # dry run against a local copy
 *   node scripts/legacy-reset/cli.mjs --remote --execute --confirm=<first 12 chars of sourceIdsSha256>
 *
 * With --remote it also refuses to run while the Apify Task has a run in progress (reads APIFY_TOKEN
 * from .env, never prints it). Prints counts only — never post content.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { APIFY_TASK_ID, apifyToken, D1_DATABASE } from '../project.mjs';
import { runLegacyReset } from './plan.mjs';

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
const manifest = JSON.parse(readFileSync(option('--manifest') ?? new URL('./manifest.json', import.meta.url), 'utf8'));

function wrangler(command, attempts = 1) {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = execFileSync(
        process.execPath,
        ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', D1_DATABASE, ...target, '--json', '--command', command],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
      );
      return JSON.parse(out.slice(out.indexOf('[')));
    } catch (error) {
      // Reads are retried (D1's API sometimes answers 7403 once); writes never are — re-run the CLI instead.
      if (attempt >= attempts) throw new Error(`wrangler d1 execute failed: ${String(error.stdout ?? error.message).match(/"text":\s*"([^"]+)"/)?.[1] ?? 'see wrangler logs'}`);
    }
  }
}

const db = {
  query: async (sql) => wrangler(sql, 3)[0]?.results ?? [],
  run: async (statements) => {
    wrangler(statements.join(';\n'));
  },
};

async function apifyRunsInProgress() {
  const token = apifyToken();
  let active = 0;
  for (const status of ['READY', 'RUNNING']) {
    const response = await fetch(`https://api.apify.com/v2/actor-tasks/${APIFY_TASK_ID}/runs?status=${status}&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Apify runs check failed (HTTP ${response.status})`);
    active += ((await response.json()).data?.items ?? []).length;
  }
  return active;
}

const execute = flag('--execute');
let report;
if (flag('--remote')) {
  const active = await apifyRunsInProgress();
  if (active > 0) {
    report = { manifest: manifest.name, state: 'blocked', reasons: [`${active} Apify run(s) of the Task in progress`], executed: false };
  }
}
report ??= await runLegacyReset(db, manifest, { execute, confirm: option('--confirm') });
console.log(JSON.stringify({ target: target.join(' '), mode: execute ? 'execute' : 'dry-run', ...report }, null, 2));
process.exit(report.state === 'blocked' || report.problems?.length ? 1 : 0);
