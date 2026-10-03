import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IngestPageMessage } from '../../src/apify/types';
import { WEBHOOK_SECRET_HEADER } from '../../src/config/env';
import { MAX_PAGE_ATTEMPTS, PAGE_SIZE } from '../../src/ingestion/ingest-service';
import { handleIngestQueue, retryDelaySeconds } from '../../src/ingestion/queue-consumer';
import { IngestRunsRepository } from '../../src/storage/ingest-runs.repository';
import { PostsRepository } from '../../src/storage/posts.repository';
import { createApp } from '../../src/worker';
import {
  executionCtx,
  fakeApify,
  fakeBatch,
  fakeMessage,
  fakeQueue,
  loadSampleItems,
  manyItems,
  resetDb,
  testEnv,
  WEBHOOK_SECRET,
  webhookPayload,
  type FakeApify,
  type FakeMessage,
} from '../helpers';

const RUN_A = 'RunPipeline000001';
const RUN_B = 'RunPipeline000002';
const NOW = new Date('2026-10-03T03:31:30.000Z');

let apify: FakeApify;
let queue: ReturnType<typeof fakeQueue>;

beforeEach(async () => {
  await resetDb();
  queue = fakeQueue();
});

/** Webhook delivery for a run, as Apify would send it. */
async function deliverWebhook(runId: string) {
  const app = createApp({ fetch: apify.fetch, now: () => NOW });
  return app.request(
    '/webhooks/apify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [WEBHOOK_SECRET_HEADER]: WEBHOOK_SECRET },
      body: JSON.stringify(webhookPayload(runId)),
    },
    testEnv({ INGEST_QUEUE: queue.queue }),
    executionCtx,
  );
}

/** Delivers one message to the consumer, like the Queues runtime (max_batch_size = 1). */
async function deliver(body: unknown, attempts = 1, envOverrides = {}): Promise<FakeMessage> {
  const message = fakeMessage(body, attempts);
  await handleIngestQueue(fakeBatch([message]), testEnv({ INGEST_QUEUE: queue.queue, ...envOverrides }), {
    fetch: apify.fetch,
    now: () => NOW,
  });
  return message;
}

/** Delivers queued messages — including pages queued while draining — until the queue is empty. */
async function drainQueue(): Promise<FakeMessage[]> {
  const delivered: FakeMessage[] = [];
  for (let guard = 0; queue.sent.length > 0 && guard < 100; guard++) {
    delivered.push(await deliver(queue.sent.shift()));
  }
  return delivered;
}

const runRow = (runId: string) => new IngestRunsRepository(env.DB).findByApifyRunId(runId);
const countPosts = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM raw_posts').first<{ n: number }>())!.n;

describe('webhook → queue → D1 (end to end)', () => {
  it('follows 25-post pages until a short one and records exact totals, including malformed items', async () => {
    expect(PAGE_SIZE).toBe(25);
    const items = [...manyItems(118), null, { content: 'no identity' }]; // 120 items, 2 malformed
    apify = fakeApify([{ id: RUN_A, items }]);

    expect((await deliverWebhook(RUN_A)).status).toBe(200);
    const messages = await drainQueue();
    const pages = messages.map((m) => m.message.body as IngestPageMessage);
    expect(pages.map((p) => p.offset)).toEqual([0, 25, 50, 75, 100]); // the last page holds the remaining 20
    expect(pages.every((p) => p.limit === 25)).toBe(true);
    expect(messages.every((m) => m.acked())).toBe(true);
    const datasetCalls = apify.calls.filter((c) => c.startsWith('/datasets/'));
    expect(datasetCalls).toHaveLength(5);
    expect(datasetCalls.every((c) => c.includes('limit=25'))).toBe(true);

    expect(await runRow(RUN_A)).toMatchObject({
      status: 'succeeded',
      pages_total: 5,
      page_size: 25,
      fetched: 120,
      new: 118,
      already_seen: 0,
      invalid: 2,
      completed_at: NOW.toISOString(),
    });
    expect(await countPosts()).toBe(118);
  });

  it('does not lose items when the dataset is still growing after the webhook (no reliance on itemCount)', async () => {
    const all = manyItems(120);
    const run = { id: RUN_A, items: all.slice(0, 100) }; // only 100 visible at webhook time
    apify = fakeApify([run]);
    await deliverWebhook(RUN_A);
    await deliver(queue.sent.shift()); // page 0
    run.items = all; // the remaining 20 items become visible
    apify.runs.get(RUN_A)!.items = all;
    await drainQueue();
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', fetched: 120, new: 120 });
    expect(await countPosts()).toBe(120);
  });

  it('handles a dataset that is an exact multiple of the page size (last page is empty)', async () => {
    apify = fakeApify([{ id: RUN_A, items: manyItems(PAGE_SIZE * 2) }]);
    await deliverWebhook(RUN_A);
    const messages = await drainQueue();
    expect(messages.map((m) => (m.message.body as IngestPageMessage).offset)).toEqual([0, 25, 50]);
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', pages_total: 3, fetched: 50, new: 50 });
  });

  it('ingests a production-sized run (3 queries × 600 posts) in 25-post pages', async () => {
    apify = fakeApify([{ id: RUN_A, items: manyItems(1800) }]);
    await deliverWebhook(RUN_A);
    const messages = await drainQueue();
    expect(messages).toHaveLength(73); // 72 full pages + the empty page that ends the chain
    expect(messages.every((m) => (m.message.body as IngestPageMessage).limit === 25)).toBe(true);
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', pages_total: 73, fetched: 1800, new: 1800 });
    expect(await countPosts()).toBe(1800);
  });

  it('completes a run with an empty dataset after probing the first page', async () => {
    apify = fakeApify([{ id: RUN_A, items: [] }]);
    await deliverWebhook(RUN_A);
    await drainQueue();
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', pages_total: 1, fetched: 0, new: 0 });
  });

  it('overlapping runs (09:00 and 21:00) store each post once and count the overlap as already seen', async () => {
    const morning = manyItems(80);
    const evening = [...morning.slice(40), ...manyItems(30, '77000000000')]; // 40 overlap + 30 new
    apify = fakeApify([
      { id: RUN_A, items: morning },
      { id: RUN_B, items: evening },
    ]);

    await deliverWebhook(RUN_A);
    await drainQueue();
    await deliverWebhook(RUN_B);
    await drainQueue();

    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', fetched: 80, new: 80, already_seen: 0 });
    expect(await runRow(RUN_B)).toMatchObject({ status: 'succeeded', fetched: 70, new: 30, already_seen: 40 });
    expect(await countPosts()).toBe(110);
    // The first run that saw a post keeps it.
    const repo = new PostsRepository(env.DB);
    const shared = await repo.findBySourceId('apify_linkedin_post_search', `li:${String(morning[40]!.id)}`);
    expect(shared?.apify_run_id).toBe(RUN_A);
  });

  it('repeated webhook and queue deliveries never duplicate posts or run history', async () => {
    apify = fakeApify([{ id: RUN_A, items: loadSampleItems() }]);
    await deliverWebhook(RUN_A);
    const firstPage = queue.sent[0]!;
    await drainQueue();

    // Apify redelivers the webhook, and the queue redelivers an old message.
    expect((await deliverWebhook(RUN_A)).status).toBe(200);
    await deliver(firstPage);

    expect(await countPosts()).toBe(6);
    expect(await new IngestRunsRepository(env.DB).list()).toHaveLength(1);
    expect(await runRow(RUN_A)).toMatchObject({ fetched: 6, new: 6, already_seen: 0, invalid: 0 });
  });

  it('a page redelivered before the run finished is not double counted', async () => {
    apify = fakeApify([{ id: RUN_A, items: manyItems(60) }]);
    await deliverWebhook(RUN_A);
    const page0 = queue.sent.shift()!;
    await deliver(page0);
    await deliver(page0); // duplicate delivery of page 0 (queues page 1 again — harmless)
    expect((await runRow(RUN_A))?.status).toBe('processing');
    await drainQueue();
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', fetched: 60, new: 60, already_seen: 0 });
  });

  it('resumes the page chain when queueing the next page failed after a page was stored', async () => {
    apify = fakeApify([{ id: RUN_A, items: manyItems(70) }]);
    await deliverWebhook(RUN_A);
    const page0 = queue.sent.shift()!;
    queue.failNextSends(1);
    const first = await deliver(page0);
    expect(first.retried()).not.toBeNull(); // page 0 stored, but "next page" could not be queued
    expect(queue.sent).toEqual([]);
    await deliver(page0, 2); // redelivery: page already stored, chain re-queued
    await drainQueue();
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', fetched: 70, new: 70 });
  });
});

describe('queue consumer — failures and retries', () => {
  beforeEach(() => {
    apify = fakeApify([{ id: RUN_A, items: manyItems(10) }]);
  });

  it('retries a page with backoff when the Apify API fails transiently', async () => {
    await deliverWebhook(RUN_A);
    apify.failWith('/datasets/', 503);
    const message = await deliver(queue.sent.shift());
    expect(message.acked()).toBe(false);
    expect(message.retried()).toEqual({ delaySeconds: retryDelaySeconds(1) });
    expect((await runRow(RUN_A))?.status).toBe('processing');
    expect(await countPosts()).toBe(0);
  });

  it('retries (not fails) when a 200 response body breaks mid-read', async () => {
    await deliverWebhook(RUN_A);
    const page0 = queue.sent.shift()!;
    apify.breakNextBody('/datasets/');
    const message = await deliver(page0);
    expect(message.retried()).toEqual({ delaySeconds: retryDelaySeconds(1) });
    expect((await runRow(RUN_A))?.status).toBe('processing');
    await deliver(page0, 2);
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', new: 10 });
  });

  it('marks the run failed (with partial totals) after the last attempt; a webhook redelivery then restarts it', async () => {
    apify = fakeApify([{ id: RUN_A, items: manyItems(70) }]);
    await deliverWebhook(RUN_A);
    await deliver(queue.sent.shift()); // page 0 succeeds and queues page 1
    apify.failWith('/datasets/', 503);
    const message = await deliver(queue.sent.shift(), MAX_PAGE_ATTEMPTS);
    expect(message.acked()).toBe(true);
    expect(await runRow(RUN_A)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('HTTP 503'),
      fetched: 25,
      new: 25,
    });

    // Recovery: Apify (or a manual re-send) delivers the webhook again.
    apify = fakeApify([{ id: RUN_A, items: manyItems(70) }]);
    expect(await (await deliverWebhook(RUN_A)).json()).toMatchObject({ status: 'queued' });
    await drainQueue();
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', fetched: 70, new: 70, already_seen: 0 });
  });

  it('marks the run failed once deliveries exceed the attempt budget (e.g. an invocation that keeps dying)', async () => {
    await deliverWebhook(RUN_A);
    const message = await deliver(queue.sent.shift(), MAX_PAGE_ATTEMPTS + 1);
    expect(message.acked()).toBe(true);
    expect(apify.calls.filter((c) => c.startsWith('/datasets/'))).toEqual([]); // no work attempted
    expect(await runRow(RUN_A)).toMatchObject({ status: 'failed', error: expect.stringContaining('kept failing') });
  });

  it('retries with backoff instead of throwing when D1 fails, even on the run lookup', async () => {
    await deliverWebhook(RUN_A);
    const brokenDb = {
      prepare: () => {
        throw new Error('D1 unavailable');
      },
      batch: () => Promise.reject(new Error('D1 unavailable')),
    } as unknown as D1Database;
    const message = await deliver(queue.sent.shift(), 1, { DB: brokenDb });
    expect(message.acked()).toBe(false);
    expect(message.retried()).toEqual({ delaySeconds: retryDelaySeconds(1) });
  });

  it('fails a page immediately on a non-retryable Apify error (e.g. 404)', async () => {
    await deliverWebhook(RUN_A);
    apify.failWith('/datasets/', 404);
    const message = await deliver(queue.sent.shift());
    expect(message.acked()).toBe(true);
    expect((await runRow(RUN_A))?.status).toBe('failed');
  });

  it('acks messages for unknown or finished runs without calling Apify', async () => {
    const stray = { apifyRunId: 'RunUnknown0000001', datasetId: 'DsUnknown00000001', offset: 0, limit: PAGE_SIZE };
    const message = await deliver(stray);
    expect(message.acked()).toBe(true);
    expect(apify.calls).toEqual([]);
  });

  it('drops malformed messages', async () => {
    const message = await deliver({ apifyRunId: '../../etc', offset: -1 });
    expect(message.acked()).toBe(true);
    expect(apify.calls).toEqual([]);
  });

  it('retries the whole batch later when APIFY_TOKEN is missing', async () => {
    const message = fakeMessage({ apifyRunId: RUN_A, datasetId: `Ds${RUN_A}`, offset: 0, limit: PAGE_SIZE });
    const batch = fakeBatch([message]);
    await handleIngestQueue(batch, testEnv({ APIFY_TOKEN: undefined }), { fetch: apify.fetch });
    expect(batch.retriedAll()).toBe(true);
    expect(apify.calls).toEqual([]);
  });

  it('backs off exponentially up to 10 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 480, 600, 600]);
  });
});
