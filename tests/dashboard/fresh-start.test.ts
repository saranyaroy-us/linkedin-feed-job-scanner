import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { runLegacyReset } from '../../scripts/legacy-reset/plan.mjs';
import { WEBHOOK_SECRET_HEADER } from '../../src/config/env';
import { SEARCH_QUERIES } from '../../src/config/search-config';
import { handleIngestQueue } from '../../src/ingestion/queue-consumer';
import { createApp } from '../../src/worker';
import {
  basicAuthHeader,
  executionCtx,
  fakeApify,
  fakeBatch,
  fakeMessage,
  fakeQueue,
  manyItems,
  resetDb,
  testEnv,
  WEBHOOK_SECRET,
  webhookPayload,
} from '../helpers';
import { LEGACY_RUNS, legacyManifest, localResetDb, seedLegacyDataset } from '../legacy-fixture';

// Real "now": legacy and new posts get created_at from D1's clock, so "Added today" must use the same day.
const NOW = new Date();
const FRESH_RUN = 'RunFreshSearch001';

async function page(path: string, apify = fakeApify()) {
  const app = createApp({ fetch: apify.fetch, now: () => NOW });
  return app.request(`https://scanner.example.workers.dev${path}`, { headers: { Authorization: basicAuthHeader() } }, testEnv(), executionCtx);
}

beforeEach(async () => {
  await resetDb();
  await seedLegacyDataset();
  const manifest = await legacyManifest();
  const report = await runLegacyReset(localResetDb, manifest, { execute: true, confirm: manifest.sourceIdsSha256.slice(0, 12), now: NOW });
  expect(report.problems).toEqual([]);
});

describe('dashboard after the legacy reset (fresh start)', () => {
  it('shows zero stored posts, zero per query, no last run and the empty state', async () => {
    const body = await (await page('/')).text();
    expect(body).toMatch(/Stored posts<\/div><div class="value">0</);
    expect(body).toMatch(/Added today<\/div><div class="value">0</);
    expect(body).toMatch(/Last ingestion<\/div><div class="value small">Never</);
    expect(body).toMatch(/Fetched<\/div><div class="value">—</); // historical runs are not the "last run"
    const counts = [...body.matchAll(/<span class="qcount num">(\d+)</g)].map((m) => Number(m[1]));
    expect(counts).toEqual(SEARCH_QUERIES.map(() => 0));
    expect(body).toContain('No US hiring posts stored yet. Run a search to discover opportunities.');
    expect(body).not.toContain('<table class="posts">');
    // Filters with no match keep their own message.
    expect(await (await page('/?q=revops')).text()).toContain('No posts match these filters.');
  });

  it('returns an empty collection from /api/posts', async () => {
    const json = (await (await page('/api/posts')).json()) as { posts: unknown[]; has_more: boolean };
    expect(json).toMatchObject({ posts: [], has_more: false });
  });

  it('keeps the historical runs in /runs, labelled as historical, with their audit counts', async () => {
    const body = await (await page('/runs')).text();
    expect(body.match(/<span class="badge historical"/g)).toHaveLength(LEGACY_RUNS.length);
    expect(body).toContain('Historical runs ran before the hiring and US-job filters and are kept as audit records.');
    for (const runId of LEGACY_RUNS) expect(body).toContain(runId);
    // Fetched 7, new 6, duplicates 1 as recorded; the hard-filter counters did not exist then ("—").
    expect(body).toMatch(
      /<td class="num">7<\/td>\s*<td class="num">6<\/td>\s*<td class="num">1<\/td>\s*<td class="num">—<\/td>\s*<td class="num">—<\/td>\s*<td class="num">—<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>/,
    );
  });

  it('shows new US posts once a fresh search is ingested', async () => {
    const items = manyItems(3, '75800000000');
    const apify = fakeApify([{ id: FRESH_RUN, items }]);
    const queue = fakeQueue();
    const app = createApp({ fetch: apify.fetch, now: () => NOW });
    const res = await app.request(
      '/webhooks/apify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [WEBHOOK_SECRET_HEADER]: WEBHOOK_SECRET },
        body: JSON.stringify(webhookPayload(FRESH_RUN)),
      },
      testEnv({ INGEST_QUEUE: queue.queue }),
      executionCtx,
    );
    expect(res.status).toBe(200);
    for (let guard = 0; queue.sent.length > 0 && guard < 10; guard++) {
      await handleIngestQueue(fakeBatch([fakeMessage(queue.sent.shift())]), testEnv({ INGEST_QUEUE: queue.queue }), {
        fetch: apify.fetch,
        now: () => NOW,
      });
    }

    const body = await (await page('/', apify)).text();
    expect(body).toMatch(/Stored posts<\/div><div class="value">3</);
    expect(body).toMatch(/Added today<\/div><div class="value">3</);
    expect(body).toMatch(/Fetched<\/div><div class="value">3</);
    expect(body).toContain('<table class="posts">');
    expect(body).not.toContain('No US hiring posts stored yet');
    const json = (await (await page('/api/posts', apify)).json()) as { posts: { job_country: string }[] };
    expect(json.posts).toHaveLength(3);
    expect(json.posts.every((post) => post.job_country === 'US')).toBe(true);
    const runs = await (await page('/runs', apify)).text();
    expect(runs.match(/<span class="badge historical"/g)).toHaveLength(LEGACY_RUNS.length); // the new run is not historical
    expect(await env.DB.prepare(`SELECT screened FROM ingest_runs WHERE apify_run_id = '${FRESH_RUN}'`).first('screened')).toBe(1);
  });
});
