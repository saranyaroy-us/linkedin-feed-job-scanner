import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IngestPageMessage } from '../../src/apify/types';
import { WEBHOOK_SECRET_HEADER } from '../../src/config/env';
import { CLASSIFIER_VERSION } from '../../src/domain/classification';
import { MAX_PAGE_ATTEMPTS, PAGE_SIZE } from '../../src/ingestion/ingest-service';
import { handleIngestQueue, retryDelaySeconds } from '../../src/ingestion/queue-consumer';
import { ClassificationsRepository } from '../../src/storage/classifications.repository';
import { IngestRunsRepository } from '../../src/storage/ingest-runs.repository';
import { PostsRepository } from '../../src/storage/posts.repository';
import { createApp } from '../../src/worker';
import {
  executionCtx,
  fakeApify,
  fakeBatch,
  fakeMessage,
  fakeQueue,
  itemsWithText,
  manyItems,
  US_JOB,
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
  for (let guard = 0; queue.sent.length > 0 && guard < 200; guard++) {
    delivered.push(await deliver(queue.sent.shift()));
  }
  return delivered;
}

const runRow = (runId: string) => new IngestRunsRepository(env.DB).findByApifyRunId(runId);
const countPosts = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM raw_posts').first<{ n: number }>())!.n;

describe('webhook → queue → D1 (end to end)', () => {
  it('follows 15-post pages until a short one and records exact totals, including malformed items', async () => {
    expect(PAGE_SIZE).toBe(15);
    // 110 items: 108 posts, one malformed US hiring item (invalid) and one with no text (dropped: no hiring).
    const items = [...manyItems(108), null, { content: 'We are hiring, but this item has no identity', job: US_JOB }];
    apify = fakeApify([{ id: RUN_A, items }]);

    expect((await deliverWebhook(RUN_A)).status).toBe(200);
    const messages = await drainQueue();
    const pages = messages.map((m) => m.message.body as IngestPageMessage);
    expect(pages.map((p) => p.offset)).toEqual([0, 15, 30, 45, 60, 75, 90, 105]); // the last page holds the remaining 5
    expect(pages.every((p) => p.limit === 15)).toBe(true);
    expect(messages.every((m) => m.acked())).toBe(true);
    const datasetCalls = apify.calls.filter((c) => c.startsWith('/datasets/'));
    expect(datasetCalls).toHaveLength(8);
    expect(datasetCalls.every((c) => c.includes('limit=15'))).toBe(true);

    expect(await runRow(RUN_A)).toMatchObject({
      status: 'succeeded',
      pages_total: 8,
      page_size: 15,
      fetched: 110,
      new: 108,
      already_seen: 0,
      invalid: 1,
      dropped_no_hiring: 1,
      completed_at: NOW.toISOString(),
    });
    expect(await countPosts()).toBe(108);
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
    expect(messages.map((m) => (m.message.body as IngestPageMessage).offset)).toEqual([0, 15, 30]);
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', pages_total: 3, fetched: 30, new: 30 });
  });

  it('ingests a large run (1,800 posts) in 15-post pages', async () => {
    apify = fakeApify([{ id: RUN_A, items: manyItems(1800) }]);
    await deliverWebhook(RUN_A);
    const messages = await drainQueue();
    expect(messages).toHaveLength(121); // 120 full pages + the empty page that ends the chain
    expect(messages.every((m) => (m.message.body as IngestPageMessage).limit === 15)).toBe(true);
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', pages_total: 121, fetched: 1800, new: 1800 });
    expect(await countPosts()).toBe(1800);
  }, 20_000);

  it('completes a run with an empty dataset after probing the first page', async () => {
    apify = fakeApify([{ id: RUN_A, items: [] }]);
    await deliverWebhook(RUN_A);
    await drainQueue();
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', pages_total: 1, fetched: 0, new: 0 });
  });

  it('overlapping runs store each post once and count the overlap as already seen', async () => {
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

  it('labels each stored post in the same transaction, once: overlaps and redeliveries keep the first label', async () => {
    const morning = manyItems(20);
    const evening = [...morning.slice(10), ...manyItems(5, '77000000000')]; // 10 overlap + 5 new
    apify = fakeApify([
      { id: RUN_A, items: morning },
      { id: RUN_B, items: evening },
    ]);
    await deliverWebhook(RUN_A);
    const firstPage = queue.sent[0];
    await drainQueue();
    await deliver(firstPage, 2); // a redelivered page that was already stored
    await deliverWebhook(RUN_B);
    await drainQueue();

    const { results } = await env.DB.prepare(
      `SELECT c.relevance, c.persona, c.title_source, c.classifier_version, c.evidence_text, p.apify_run_id
       FROM post_classifications c JOIN raw_posts p ON p.id = c.post_id`,
    ).all<Record<string, unknown>>();
    expect(results).toHaveLength(25); // one label per stored post
    for (const row of results) {
      // manyItems() posts carry a US job card titled "Revenue Operations Manager".
      expect(row).toMatchObject({
        relevance: 'relevant',
        persona: 'revenue_operations',
        title_source: 'job_card',
        classifier_version: CLASSIFIER_VERSION,
        evidence_text: 'Revenue Operations Manager',
      });
    }
    expect(await new ClassificationsRepository(env.DB).counts()).toEqual({ relevant: 25, needs_review: 0, unrelated: 0, not_a_job: 0 });
  });

  it('repeated webhook and queue deliveries never duplicate posts or run history', async () => {
    // Three posts that pass both hard filters, and one item dropped by each filter.
    const items = [
      ...manyItems(3),
      ...itemsWithText(['Join our team'], '79100000000'),
      ...itemsWithText(['We are hiring in London, UK'], '79200000000', null),
      ...itemsWithText(["We're hiring! DM me for details"], '79300000000', null),
    ];
    apify = fakeApify([{ id: RUN_A, items }]);
    await deliverWebhook(RUN_A);
    const firstPage = queue.sent[0]!;
    await drainQueue();

    // Apify redelivers the webhook, and the queue redelivers an old message.
    expect((await deliverWebhook(RUN_A)).status).toBe(200);
    await deliver(firstPage);

    expect(await countPosts()).toBe(3);
    expect(await new IngestRunsRepository(env.DB).list()).toHaveLength(1);
    expect(await runRow(RUN_A)).toMatchObject({
      fetched: 6,
      new: 3,
      already_seen: 0,
      invalid: 0,
      dropped_no_hiring: 1,
      dropped_non_us: 1,
      dropped_location_unknown: 1,
    });
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

describe('hard "hiring" filter', () => {
  const STORED = ['We are hiring', 'Hiring now', 'HIRING: RevOps lead', 'Join us #hiring', 'Big news #Hiring', '𝗛𝗶𝗿𝗶𝗻𝗴 a Sales Ops Analyst', 'WeAreHiring'];
  const DROPPED = ['We are recruiting', 'Open role available', 'Join our team', 'Now accepting applications'];
  const sourceIds = (items: Record<string, unknown>[]) => items.map((item) => `li:${String(item.id)}`);
  const storedIds = async () =>
    (await env.DB.prepare('SELECT source_id FROM raw_posts ORDER BY source_id').all<{ source_id: string }>()).results.map((r) => r.source_id);

  it('stores only posts whose text contains "hiring" (any case or Unicode style); the rest never reach D1', async () => {
    const stored = itemsWithText(STORED, '78100000000');
    const dropped = itemsWithText(DROPPED, '78200000000');
    const rescued = itemsWithText(DROPPED.map((text) => `${text}. We are hiring!`), '78300000000');
    apify = fakeApify([{ id: RUN_A, items: [...stored, ...dropped, ...rescued] }]);
    await deliverWebhook(RUN_A);
    await drainQueue();

    expect(await storedIds()).toEqual([...sourceIds(stored), ...sourceIds(rescued)].sort());
    expect(await runRow(RUN_A)).toMatchObject({
      status: 'succeeded',
      fetched: 15,
      new: 11,
      already_seen: 0,
      invalid: 0,
      dropped_no_hiring: 4,
    });
    // Nothing of a dropped post is kept: no row, no raw_json, no counter entry.
    const { n } = (await env.DB.prepare('SELECT COUNT(*) AS n FROM raw_posts WHERE instr(raw_json, ?) > 0').bind('Open role available').first<{ n: number }>())!;
    expect(n).toBe(1); // only the rescued copy, which also says "hiring"
    const { posts } = (await env.DB.prepare('SELECT SUM(posts) AS posts FROM post_query_counts').first<{ posts: number }>())!;
    expect(posts).toBe(11);
  });

  it('counts dropped posts separately from invalid items and duplicates', async () => {
    const [kept, again] = itemsWithText(['We are hiring a RevOps lead', 'Also hiring a Vendor Manager'], '78400000000');
    apify = fakeApify([
      { id: RUN_A, items: [kept] },
      {
        id: RUN_B,
        items: [
          kept, // duplicate of a stored post
          again, // new
          { content: 'hiring, but no identity', job: US_JOB }, // invalid
          ...itemsWithText(['Join our team', 'Open role available'], '78500000000'), // dropped
          null, // no text at all: dropped
        ],
      },
    ]);
    await deliverWebhook(RUN_A);
    await drainQueue();
    await deliverWebhook(RUN_B);
    await drainQueue();
    expect(await runRow(RUN_B)).toMatchObject({ fetched: 6, new: 1, already_seen: 1, invalid: 1, dropped_no_hiring: 3 });
    expect(await countPosts()).toBe(2);
  });

  it('does not double-count dropped posts when a page is delivered again', async () => {
    const page0 = [...manyItems(20, '78600000000'), ...itemsWithText(DROPPED.concat('Join our team!'), '78700000000')];
    apify = fakeApify([{ id: RUN_A, items: [...page0, ...manyItems(10, '78800000000')] }]);
    await deliverWebhook(RUN_A);
    const first = queue.sent.shift()!;
    await deliver(first);
    await deliver(first); // redelivered after it was stored
    await drainQueue();
    expect(await runRow(RUN_A)).toMatchObject({ status: 'succeeded', fetched: 35, new: 30, dropped_no_hiring: 5, invalid: 0, already_seen: 0 });
  });
});

describe('hard US-job filter', () => {
  const JOB_URL = 'https://www.linkedin.com/jobs/view/4474331394/';
  const stored = async () =>
    (
      await env.DB.prepare(
        `SELECT source_id, job_title, company_name, job_location_text, job_country, location_source, work_mode,
                linkedin_job_url, external_apply_url
         FROM raw_posts ORDER BY source_id`,
      ).all<Record<string, unknown>>()
    ).results;

  it('stores only hiring posts whose job is confidently in the US, with their job details and links', async () => {
    const [byJobCard] = itemsWithText(['We are hiring a RevOps Analyst'], '79400000000', {
      title: 'RevOps Analyst',
      linkedinUrl: `${JOB_URL}?refId=abc%3D%3D&trackingId=abc%3D%3D`,
      location: 'San Francisco, CA (Hybrid)',
      subtitle: 'Job by Acme Corp',
    });
    const [byArticle] = itemsWithText(["We're hiring! Details below."], '79500000000', null);
    byArticle!.article = {
      title: 'Sales Operations Manager',
      subtitle: 'Example Co · Denver, CO (Hybrid)',
      link: 'https://www.linkedin.com/jobs/view/4400000002/?trackingId=xyz',
    };
    const [byText] = itemsWithText(['Hiring Sales Operations Analyst - New York, NY. Apply here: https://lnkd.in/gAbC123'], '79600000000', null);
    const nonUs = [
      ...itemsWithText(['Hiring Sales Operations Manager - London, UK', 'Hiring RevOps Analyst - Toronto, Canada'], '79700000000', null),
      ...itemsWithText(['We are hiring'], '79710000000', { title: 'Vendor Manager', location: 'Bangalore, Karnataka, India' }),
    ];
    const unknown = itemsWithText(
      ['Hiring Sales Operations Manager', 'Hiring RevOps - Remote', "We're hiring! DM me for details", "We're hiring a Sales Ops Manager"],
      '79800000000',
      null,
    );
    (unknown[3]!.author as Record<string, unknown>).info = 'Talent Partner | New York, NY'; // the author's location never counts
    const noHiring = itemsWithText(['Join our team in Austin, TX'], '79900000000'); // US job card, but no "hiring"

    apify = fakeApify([{ id: RUN_A, items: [byJobCard, byArticle, byText, ...nonUs, ...unknown, ...noHiring] }]);
    await deliverWebhook(RUN_A);
    await drainQueue();

    expect(await runRow(RUN_A)).toMatchObject({
      status: 'succeeded',
      fetched: 11,
      new: 3,
      already_seen: 0,
      invalid: 0,
      out_of_range: 0,
      dropped_no_hiring: 1,
      dropped_non_us: 3,
      dropped_location_unknown: 4,
    });
    expect(await stored()).toEqual([
      {
        source_id: `li:${String(byJobCard!.id)}`,
        job_title: 'RevOps Analyst',
        company_name: 'Acme Corp',
        job_location_text: 'San Francisco, CA',
        job_country: 'US',
        location_source: 'job',
        work_mode: 'hybrid',
        linkedin_job_url: JOB_URL,
        external_apply_url: null,
      },
      {
        source_id: `li:${String(byArticle!.id)}`,
        job_title: 'Sales Operations Manager',
        company_name: null,
        job_location_text: 'Denver, CO',
        job_country: 'US',
        location_source: 'article',
        work_mode: 'hybrid',
        linkedin_job_url: 'https://www.linkedin.com/jobs/view/4400000002/',
        external_apply_url: null,
      },
      {
        source_id: `li:${String(byText!.id)}`,
        job_title: 'Sales Operations Analyst',
        company_name: null,
        job_location_text: 'New York, NY',
        job_country: 'US',
        location_source: 'post_text',
        work_mode: 'unknown',
        linkedin_job_url: null,
        external_apply_url: 'https://lnkd.in/gAbC123',
      },
    ]);
    // Dropped posts never reach D1: no row and no per-query count.
    const { posts } = (await env.DB.prepare('SELECT SUM(posts) AS posts FROM post_query_counts').first<{ posts: number }>())!;
    expect(posts).toBe(3);
  });

  it('counts each dropped item once, apart from duplicates and invalid items', async () => {
    const [kept] = itemsWithText(['We are hiring a RevOps lead'], '80000000000');
    apify = fakeApify([
      { id: RUN_A, items: [kept] },
      {
        id: RUN_B,
        items: [
          kept, // duplicate of a stored post
          { content: 'Hiring a RevOps lead in Austin, TX, but no identity' }, // US, but invalid
          { content: 'Hiring a RevOps lead in London, UK, and no identity' }, // non-US: dropped before normalization
          { content: 'Hiring, no location and no identity' }, // location unknown: dropped before normalization
        ],
      },
    ]);
    await deliverWebhook(RUN_A);
    await drainQueue();
    await deliverWebhook(RUN_B);
    await drainQueue();
    expect(await runRow(RUN_B)).toMatchObject({
      fetched: 4,
      new: 0,
      already_seen: 1,
      invalid: 1,
      dropped_no_hiring: 0,
      dropped_non_us: 1,
      dropped_location_unknown: 1,
    });
    expect(await countPosts()).toBe(1);
  });

  it('does not double-count US-filter drops when a page or the webhook is delivered again', async () => {
    const page0 = [
      ...manyItems(20, '80100000000'),
      ...itemsWithText(['Hiring - London, UK', 'Hiring - Berlin, Germany', 'Hiring - Sydney, Australia'], '80200000000', null),
      ...itemsWithText(['Hiring RevOps - Remote', 'Hiring now'], '80300000000', null),
    ];
    apify = fakeApify([{ id: RUN_A, items: [...page0, ...manyItems(10, '80400000000')] }]);
    await deliverWebhook(RUN_A);
    const first = queue.sent.shift()!;
    await deliver(first);
    await deliver(first); // redelivered after it was stored
    await drainQueue();
    expect((await deliverWebhook(RUN_A)).status).toBe(200); // webhook redelivered after the run finished
    await drainQueue();
    await deliver(first); // and an old message once more
    expect(await runRow(RUN_A)).toMatchObject({
      status: 'succeeded',
      fetched: 35,
      new: 30,
      already_seen: 0,
      invalid: 0,
      dropped_no_hiring: 0,
      dropped_non_us: 3,
      dropped_location_unknown: 2,
    });
    expect(await countPosts()).toBe(30);
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
      fetched: PAGE_SIZE,
      new: PAGE_SIZE,
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
