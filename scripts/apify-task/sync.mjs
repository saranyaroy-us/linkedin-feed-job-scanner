#!/usr/bin/env node
/**
 * Keeps the saved Apify Task's stored input equal to the production search configuration, so a run
 * started from the Apify Console uses the same queries as dashboard Run Search. ./task-input.json mirrors
 * PRODUCTION_SEARCH_CONFIG (src/config/search-config.ts; a test fails if they differ).
 *
 *   node scripts/apify-task/sync.mjs            # dry run: shows the differences, writes nothing
 *   node scripts/apify-task/sync.mjs --apply    # updates the stored input, then re-reads and verifies it
 *
 * Only the stored input is written (PUT /actor-tasks/{id}/input merges the given fields); run options
 * such as the max total charge, and the Task's webhooks, are read before and after to show they are
 * unchanged. Reads APIFY_TOKEN from .env and never prints it.
 */
import { readFileSync } from 'node:fs';
import { APIFY_TASK_ID, apifyToken } from '../project.mjs';

const apply = process.argv.includes('--apply');
const target = JSON.parse(readFileSync(new URL('./task-input.json', import.meta.url), 'utf8'));
const token = apifyToken();

async function api(method, path, body) {
  const response = await fetch(`https://api.apify.com/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}`);
  const json = await response.json();
  return json.data ?? json;
}

const settings = async () => {
  const task = await api('GET', `/actor-tasks/${APIFY_TASK_ID}`);
  const hooks = await api('GET', `/actor-tasks/${APIFY_TASK_ID}/webhooks?limit=50`);
  return { options: task.options, webhooks: (hooks.items ?? []).map((h) => ({ id: h.id, eventTypes: h.eventTypes })) };
};

const differences = (stored) =>
  [...new Set([...Object.keys(stored), ...Object.keys(target)])]
    .sort()
    .filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(target[key]))
    .map((key) => ({ key, stored: stored[key] ?? null, target: target[key] ?? null }));

const before = await api('GET', `/actor-tasks/${APIFY_TASK_ID}/input`);
const settingsBefore = await settings();
const changes = differences(before);
const storedOnly = Object.keys(before).filter((key) => !(key in target));
console.log(JSON.stringify({ task: APIFY_TASK_ID, mode: apply ? 'apply' : 'dry-run', changes, settings: settingsBefore }, null, 2));
if (storedOnly.length) {
  console.error(`Stored-only fields ${storedOnly.join(', ')} are not removed by this update; remove them in the Apify Console first.`);
  process.exit(1);
}
if (!changes.length) {
  console.log('The stored input already matches the production configuration.');
  process.exit(0);
}
if (!apply) {
  console.log('Dry run: nothing written. Re-run with --apply to update the stored input.');
  process.exit(0);
}

await api('PUT', `/actor-tasks/${APIFY_TASK_ID}/input`, target);
const after = await api('GET', `/actor-tasks/${APIFY_TASK_ID}/input`);
const settingsAfter = await settings();
const remaining = differences(after);
const settingsKept = JSON.stringify(settingsAfter) === JSON.stringify(settingsBefore);
console.log(JSON.stringify({ verified: remaining.length === 0 && settingsKept, remaining, settingsKept }, null, 2));
process.exit(remaining.length === 0 && settingsKept ? 0 : 1);
