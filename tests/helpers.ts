import { env } from 'cloudflare:workers';
import type { FetchLike } from '../src/apify/client';
import type { IngestPageMessage } from '../src/apify/types';
import { ACTOR_ID } from '../src/config/search-config';
import type { Env } from '../src/config/env';
import fixture from './fixtures/apify-posts.sample.json';

export const FETCHED_AT = '2026-10-03T03:35:00.000Z';
export const APIFY_RUN_ID = 'RunAaaaaaaaaaaaa1';
export const CONTEXT = { fetchedAt: FETCHED_AT, apifyRunId: APIFY_RUN_ID };

export const TEST_USER_ID = 'UserTest000000001';
export const TEST_TASK_ID = 'TaskTest000000001';
export const WEBHOOK_SECRET = 'test-webhook-secret';
export const APIFY_TOKEN = 'test-apify-token';

/**
 * The sanitized real-structure fixture. Order: 0 repost, 1 company author,
 * 2 article/hiring, 3 ugcPost (engagement.id differs), 4 unrelated job, 5 career update.
 */
export function loadSampleItems(): Record<string, unknown>[] {
  return structuredClone(fixture) as Record<string, unknown>[];
}

export function sampleItem(index: number): Record<string, unknown> {
  const item = loadSampleItems()[index];
  if (!item) throw new Error(`no fixture item #${index}`);
  return item;
}

/** A structured job card (the Actor's `job` object) located in the US. */
export const US_JOB = { title: 'Revenue Operations Manager', location: 'New York, NY' } as const;

/**
 * `count` distinct items cloned from the fixture with unique ids (for multi-page
 * runs). Each mentions "hiring" (appended where the fixture text lacks it) and
 * carries a US job card, so it passes both hard ingestion filters.
 */
export function manyItems(count: number, idPrefix = '76000000000'): Record<string, unknown>[] {
  const base = loadSampleItems();
  return Array.from({ length: count }, (_, i) => {
    const item = structuredClone(base[i % base.length]!);
    const id = `${idPrefix}${String(i).padStart(8, '0')}`;
    item.id = id;
    item.entityId = id;
    item.linkedinUrl = `https://www.linkedin.com/posts/sample_activity-${id}-abcd`;
    if (!/hiring/i.test(String(item.content ?? ''))) item.content = `${String(item.content ?? '')} #hiring`.trim();
    item.job = { ...US_JOB };
    return item;
  });
}

/**
 * Distinct fixture clones (unique ids) with exactly these post texts and no
 * attached article. They keep the US job card unless `job` is null, so the
 * post text alone decides the job location.
 */
export function itemsWithText(
  texts: readonly string[],
  idPrefix = '78000000000',
  job: Record<string, unknown> | null = US_JOB,
): Record<string, unknown>[] {
  return manyItems(texts.length, idPrefix).map((item, i) => {
    const { job: _job, article: _article, ...rest } = item;
    return job ? { ...rest, content: texts[i], job: { ...job } } : { ...rest, content: texts[i] };
  });
}

/**
 * Normalized posts as the US-job filter stores them (job_country 'US'): the
 * dashboard and /api/posts list only those. Tests that insert posts directly
 * (bypassing ingestion) use this unless they need an unclassified row.
 */
export const asUsPosts = <T extends Record<string, unknown>>(posts: readonly T[]): T[] =>
  posts.map((post) => ({ ...post, job_country: 'US', location_source: 'post_text' }));

/** Clears all tables (D1 storage is shared between tests of one file). */
export async function resetDb(db: D1Database = env.DB): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM ingest_run_pages'),
    db.prepare('DELETE FROM ingest_runs'),
    db.prepare('DELETE FROM raw_posts'),
    db.prepare('DELETE FROM post_query_counts'),
    db.prepare('DELETE FROM search_runs'),
  ]);
}

export interface FakeRun {
  id: string;
  userId?: string;
  actId?: string;
  actorTaskId?: string | null;
  status?: string;
  datasetId?: string;
  keyValueStoreId?: string | null;
  items?: unknown[];
  input?: unknown;
}

export interface FakeApify {
  fetch: FetchLike;
  /** Request paths (with query) seen, in order. */
  calls: string[];
  /** "METHOD path" of every request, in order. */
  requests: string[];
  /** Task runs started through POST /actor-tasks/{id}/runs, with the input override sent. */
  startedRuns: { taskId: string; runId: string; input: unknown }[];
  /** Authorization header values seen. */
  authHeaders: (string | null)[];
  runs: Map<string, FakeRun>;
  /** Make every request to a path starting with this prefix fail with the given status. */
  failWith: (pathPrefix: string, status: number) => void;
  /** Make the next request to a path with this prefix return 200 with a body that fails mid-read. */
  breakNextBody: (pathPrefix: string) => void;
}

/** Task runs started across all fakes of a test file, so run ids stay unique like Apify's. */
let startedRunCount = 0;

/**
 * A fake of the Apify API endpoints the Worker uses (users/me, run, run INPUT,
 * dataset items, run task). A started task run is added to `runs` as READY with
 * no items; a test sets its status and items before delivering its webhook.
 */
export function fakeApify(runs: FakeRun[] = [], userId = TEST_USER_ID): FakeApify {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const failures: [string, number][] = [];
  const brokenBodies: string[] = [];
  const calls: string[] = [];
  const requests: string[] = [];
  const startedRuns: FakeApify['startedRuns'] = [];
  const authHeaders: (string | null)[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (url.origin !== 'https://api.apify.com') throw new Error(`unexpected host ${url.host}`);
    const path = url.pathname.replace(/^\/v2/, '');
    const method = init?.method ?? 'GET';
    calls.push(path + url.search);
    requests.push(`${method} ${path}`);
    authHeaders.push(new Headers(init?.headers).get('Authorization'));
    const failure = failures.find(([prefix]) => path.startsWith(prefix));
    if (failure) return json({ error: { type: 'failure' } }, failure[1]);
    const broken = brokenBodies.findIndex((prefix) => path.startsWith(prefix));
    if (broken >= 0) {
      brokenBodies.splice(broken, 1);
      // 200 whose body stream dies mid-read (connection reset / timeout).
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[{"id":'));
          controller.error(new Error('connection reset'));
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/users/me') return json({ data: { id: userId } });

    let m = path.match(/^\/actor-tasks\/([^/]+)\/runs$/);
    if (m && method === 'POST') {
      const taskId = m[1]!;
      const runId = `RunStarted${String(++startedRunCount).padStart(7, '0')}`;
      const input: unknown = JSON.parse(String(init?.body));
      byId.set(runId, { id: runId, actorTaskId: taskId, status: 'READY', items: [], input });
      startedRuns.push({ taskId, runId, input });
      const data = {
        id: runId,
        userId,
        actId: ACTOR_ID,
        actorTaskId: taskId,
        status: 'READY',
        defaultDatasetId: `Ds${runId}`,
        defaultKeyValueStoreId: `Kv${runId}`,
      };
      return json({ data }, 201);
    }

    m = path.match(/^\/actor-runs\/([^/]+)$/);
    if (m) {
      const run = byId.get(m[1]!);
      if (!run) return json({ error: { type: 'record-not-found' } }, 404);
      return json({
        data: {
          id: run.id,
          userId: run.userId ?? userId,
          actId: run.actId ?? ACTOR_ID,
          actorTaskId: run.actorTaskId === undefined ? TEST_TASK_ID : run.actorTaskId,
          status: run.status ?? 'SUCCEEDED',
          defaultDatasetId: run.datasetId ?? `Ds${run.id}`,
          defaultKeyValueStoreId: run.keyValueStoreId === undefined ? `Kv${run.id}` : run.keyValueStoreId,
        },
      });
    }

    const findByDataset = (id: string) => [...byId.values()].find((r) => (r.datasetId ?? `Ds${r.id}`) === id);
    m = path.match(/^\/datasets\/([^/]+)\/items$/);
    if (m) {
      const run = findByDataset(m[1]!);
      if (!run) return json({ error: { type: 'record-not-found' } }, 404);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      return json((run.items ?? []).slice(offset, offset + limit));
    }

    m = path.match(/^\/key-value-stores\/([^/]+)\/records\/INPUT$/);
    if (m) {
      const run = [...byId.values()].find((r) => (r.keyValueStoreId ?? `Kv${r.id}`) === m![1]);
      if (!run || run.input === undefined) return json({ error: { type: 'record-not-found' } }, 404);
      return json(run.input);
    }

    return json({ error: { type: 'page-not-found' } }, 404);
  };

  return {
    fetch,
    calls,
    requests,
    startedRuns,
    authHeaders,
    runs: byId,
    failWith: (prefix, status) => failures.push([prefix, status]),
    breakNextBody: (prefix) => brokenBodies.push(prefix),
  };
}

export interface FakeQueue {
  queue: Queue<IngestPageMessage>;
  sent: IngestPageMessage[];
  /** Make the next `count` sends throw. */
  failNextSends: (count: number) => void;
}

/** Captures messages instead of delivering them, so tests drive the consumer explicitly. */
export function fakeQueue(options: { failSend?: boolean } = {}): FakeQueue {
  const sent: IngestPageMessage[] = [];
  let failures = 0;
  const check = () => {
    if (options.failSend) throw new Error('queue unavailable');
    if (failures > 0) {
      failures--;
      throw new Error('queue unavailable');
    }
  };
  const queue = {
    async send(body: IngestPageMessage) {
      check();
      sent.push(body);
    },
    async sendBatch(messages: Iterable<MessageSendRequest<IngestPageMessage>>) {
      check();
      for (const message of messages) sent.push(message.body);
    },
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  };
  return {
    queue: queue as unknown as Queue<IngestPageMessage>,
    sent,
    failNextSends: (count) => {
      failures = count;
    },
  };
}

export interface FakeMessage {
  message: Message<unknown>;
  acked: () => boolean;
  retried: () => { delaySeconds?: number } | null;
}

export function fakeMessage(body: unknown, attempts = 1): FakeMessage {
  let acked = false;
  let retried: { delaySeconds?: number } | null = null;
  const message = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: () => {
      acked = true;
    },
    retry: (options?: { delaySeconds?: number }) => {
      retried = options ?? {};
    },
  } as unknown as Message<unknown>;
  return { message, acked: () => acked, retried: () => retried };
}

export function fakeBatch(messages: FakeMessage[]): MessageBatch<unknown> & { retriedAll: () => boolean } {
  let retriedAll = false;
  return {
    queue: 'linkedin-ingest-pages',
    messages: messages.map((m) => m.message),
    ackAll: () => messages.forEach((m) => m.message.ack()),
    retryAll: () => {
      retriedAll = true;
    },
    retriedAll: () => retriedAll,
  } as unknown as MessageBatch<unknown> & { retriedAll: () => boolean };
}

/** Worker bindings for a test: the real local D1 plus overridable secrets and a fake queue. */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    INGEST_QUEUE: fakeQueue().queue,
    APIFY_TOKEN,
    APIFY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    DASHBOARD_USERNAME: 'admin',
    DASHBOARD_PASSWORD: 'test-dashboard-password',
    DISPLAY_TIMEZONE: 'Asia/Kolkata',
    APIFY_TASK_ID: '',
    ...overrides,
  };
}

export const basicAuthHeader = (user = 'admin', password = 'test-dashboard-password') =>
  `Basic ${btoa(`${user}:${password}`)}`;

/** Minimal ExecutionContext for app.request. */
export const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

/** Default Apify webhook payload (as Apify sends it) for a run id. */
export function webhookPayload(runId: string, eventType = 'ACTOR.RUN.SUCCEEDED') {
  return {
    userId: TEST_USER_ID,
    createdAt: '2026-10-03T03:31:00.000Z',
    eventType,
    eventData: { actorId: ACTOR_ID, actorTaskId: TEST_TASK_ID, actorRunId: runId },
    resource: { id: runId, actId: ACTOR_ID, status: 'SUCCEEDED', defaultDatasetId: `Ds${runId}` },
  };
}
