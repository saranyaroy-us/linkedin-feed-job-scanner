import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { WEBHOOK_SECRET_HEADER, type Env } from '../../src/config/env';
import { PAGE_SIZE } from '../../src/ingestion/ingest-service';
import { IngestRunsRepository } from '../../src/storage/ingest-runs.repository';
import { createApp } from '../../src/worker';
import {
  APIFY_TOKEN,
  executionCtx,
  fakeApify,
  fakeQueue,
  manyItems,
  resetDb,
  TEST_TASK_ID,
  testEnv,
  WEBHOOK_SECRET,
  webhookPayload,
  type FakeApify,
} from '../helpers';

const RUN = 'RunWebhook0000001';
const NOW = new Date('2026-10-03T03:31:30.000Z');

let apify: FakeApify;
let queue: ReturnType<typeof fakeQueue>;

beforeEach(async () => {
  await resetDb();
  apify = fakeApify([{ id: RUN, items: manyItems(120), input: { maxPosts: 100, postedLimit: '24h' } }]);
  queue = fakeQueue();
});

function post(body: unknown, options: { secret?: string | null; env?: Partial<Env>; raw?: string } = {}) {
  const app = createApp({ fetch: apify.fetch, now: () => NOW });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const secret = options.secret === undefined ? WEBHOOK_SECRET : options.secret;
  if (secret !== null) headers[WEBHOOK_SECRET_HEADER] = secret;
  return app.request(
    'https://scanner.example.workers.dev/webhooks/apify',
    { method: 'POST', headers, body: options.raw ?? JSON.stringify(body) },
    testEnv({ INGEST_QUEUE: queue.queue, ...options.env }),
    executionCtx,
  );
}

describe('POST /webhooks/apify — authentication', () => {
  it('fails closed (503) when the secrets are not configured', async () => {
    expect((await post(webhookPayload(RUN), { env: { APIFY_WEBHOOK_SECRET: undefined } })).status).toBe(503);
    expect((await post(webhookPayload(RUN), { env: { APIFY_TOKEN: '' } })).status).toBe(503);
    expect(apify.calls).toEqual([]);
  });

  it('rejects a missing or wrong secret with 401 before doing any work', async () => {
    expect((await post(webhookPayload(RUN), { secret: null })).status).toBe(401);
    expect((await post(webhookPayload(RUN), { secret: 'wrong' })).status).toBe(401);
    expect((await post(webhookPayload(RUN), { secret: `${WEBHOOK_SECRET}x` })).status).toBe(401);
    expect((await post(webhookPayload(RUN), { secret: '' })).status).toBe(401);
    expect(apify.calls).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it('never accepts an empty secret even when the configured one is empty', async () => {
    expect((await post(webhookPayload(RUN), { secret: '', env: { APIFY_WEBHOOK_SECRET: '' } })).status).toBe(503);
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await post(null, { raw: JSON.stringify({ eventType: 'x', pad: 'x'.repeat(70 * 1024) }) });
    expect(res.status).toBe(413);
  });
});

describe('POST /webhooks/apify — payload handling', () => {
  it('rejects invalid JSON and non-webhook bodies with 422', async () => {
    expect((await post(null, { raw: '{not json' })).status).toBe(422);
    expect((await post({ hello: 'world' })).status).toBe(422);
  });

  it('acknowledges Apify "Test" deliveries and other events with 200 without ingesting', async () => {
    for (const eventType of ['TEST', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.CREATED']) {
      const res = await post(webhookPayload(RUN, eventType));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ignored', eventType });
    }
    expect(apify.calls).toEqual([]);
  });

  it('rejects a missing or malformed run id with 422 (never reaches an Apify URL)', async () => {
    const payload = webhookPayload(RUN);
    expect((await post({ ...payload, eventData: {}, resource: {} })).status).toBe(422);
    expect((await post({ ...payload, eventData: { actorRunId: '../users/me' } })).status).toBe(422);
    expect(apify.calls).toEqual([]);
  });

  it('falls back to resource.id when eventData has no run id', async () => {
    const res = await post({ ...webhookPayload(RUN), eventData: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'queued', apifyRunId: RUN });
  });
});

describe('POST /webhooks/apify — run verification (payload is not trusted)', () => {
  it('ignores runs of another Apify account', async () => {
    apify.runs.get(RUN)!.userId = 'SomeoneElse000001';
    const res = await post(webhookPayload(RUN));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ignored', reason: expect.stringContaining('account') });
    expect(queue.sent).toEqual([]);
    expect(await new IngestRunsRepository(env.DB).list()).toEqual([]);
  });

  it('ignores runs of another Actor', async () => {
    apify.runs.get(RUN)!.actId = 'OtherActor0000001';
    expect(await (await post(webhookPayload(RUN))).json()).toMatchObject({ status: 'ignored' });
    expect(queue.sent).toEqual([]);
  });

  it('ignores runs whose real status is not SUCCEEDED', async () => {
    apify.runs.get(RUN)!.status = 'FAILED';
    expect(await (await post(webhookPayload(RUN))).json()).toMatchObject({ status: 'ignored' });
  });

  it('when APIFY_TASK_ID is set, ignores runs of other tasks', async () => {
    const other = await post(webhookPayload(RUN), { env: { APIFY_TASK_ID: 'TaskOther00000001' } });
    expect(await other.json()).toMatchObject({ status: 'ignored', reason: expect.stringContaining('Task') });
    const ours = await post(webhookPayload(RUN), { env: { APIFY_TASK_ID: TEST_TASK_ID } });
    expect(await ours.json()).toMatchObject({ status: 'queued' });
  });

  it('returns 422 for an unknown run and 502 when the Apify API fails (so Apify retries)', async () => {
    expect((await post(webhookPayload('RunUnknown0000001'))).status).toBe(422);
    apify.failWith('/actor-runs/', 500);
    expect((await post(webhookPayload(RUN))).status).toBe(502);
  });

  it('authenticates to Apify with the Bearer token and never puts it in a URL or response', async () => {
    const res = await post(webhookPayload(RUN));
    const text = await res.text();
    expect(apify.authHeaders.every((h) => h === `Bearer ${APIFY_TOKEN}`)).toBe(true);
    expect(apify.calls.join(' ')).not.toContain(APIFY_TOKEN);
    expect(text).not.toContain(APIFY_TOKEN);
    expect(text).not.toContain(WEBHOOK_SECRET);
  });
});

describe('POST /webhooks/apify — queueing and idempotency', () => {
  it('records the run and queues the first dataset page (the run is never sized up front)', async () => {
    const res = await post(webhookPayload(RUN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'queued', apifyRunId: RUN });
    expect(queue.sent).toEqual([{ apifyRunId: RUN, datasetId: `Ds${RUN}`, offset: 0, limit: PAGE_SIZE }]);

    const run = await new IngestRunsRepository(env.DB).findByApifyRunId(RUN);
    expect(run).toMatchObject({
      status: 'processing',
      dataset_id: `Ds${RUN}`,
      pages_total: 0,
      started_at: NOW.toISOString(),
    });
    expect(JSON.parse(run!.query_config_json!)).toEqual({ maxPosts: 100, postedLimit: '24h' });
    // The dataset's itemCount (which can lag) is never consulted.
    expect(apify.calls.some((call) => call.startsWith('/datasets/'))).toBe(false);
  });

  it('a redelivery while processing gets 409 (Apify retries later) and queues nothing new', async () => {
    await post(webhookPayload(RUN));
    const res = await post(webhookPayload(RUN));
    expect(res.status).toBe(409);
    expect(queue.sent).toHaveLength(1);
    expect(await new IngestRunsRepository(env.DB).list()).toHaveLength(1);
  });

  it('a redelivery after success is a cheap 200 no-op', async () => {
    await post(webhookPayload(RUN));
    await env.DB.prepare("UPDATE ingest_runs SET status = 'succeeded'").run();
    apify.calls.length = 0;
    const res = await post(webhookPayload(RUN));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'duplicate' });
    expect(apify.calls).toEqual([]);
    expect(queue.sent).toHaveLength(1);
  });

  it('a redelivery after a failed run restarts it', async () => {
    await post(webhookPayload(RUN));
    await env.DB.prepare("UPDATE ingest_runs SET status = 'failed', error = 'x'").run();
    const res = await post(webhookPayload(RUN));
    expect(await res.json()).toMatchObject({ status: 'queued' });
    expect(queue.sent).toHaveLength(2);
    expect(await new IngestRunsRepository(env.DB).list()).toHaveLength(1);
  });

  it('a restarted run is queued with its original page size, so recorded pages line up', async () => {
    await post(webhookPayload(RUN));
    await env.DB.prepare("UPDATE ingest_runs SET status = 'failed', page_size = 25").run();
    queue.sent.length = 0;
    await post(webhookPayload(RUN));
    expect(queue.sent).toEqual([{ apifyRunId: RUN, datasetId: `Ds${RUN}`, offset: 0, limit: 25 }]);
  });

  it('marks the run failed and returns 503 when the queue is unavailable, so a retry can restart it', async () => {
    const broken = fakeQueue({ failSend: true });
    const res = await post(webhookPayload(RUN), { env: { INGEST_QUEUE: broken.queue } });
    expect(res.status).toBe(503);
    expect((await new IngestRunsRepository(env.DB).findByApifyRunId(RUN))?.status).toBe('failed');
    expect(await (await post(webhookPayload(RUN))).json()).toMatchObject({ status: 'queued' });
  });

  it('stores null config when the run has no readable INPUT record', async () => {
    apify.runs.get(RUN)!.input = undefined;
    await post(webhookPayload(RUN));
    expect((await new IngestRunsRepository(env.DB).findByApifyRunId(RUN))?.query_config_json).toBeNull();
  });
});
