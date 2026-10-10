import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { WEBHOOK_SECRET_HEADER, type Env } from '../../src/config/env';
import { PRODUCTION_SEARCH_CONFIG } from '../../src/config/search-config';
import type { IngestRun } from '../../src/domain/ingest-run';
import type { SearchRun } from '../../src/domain/search-run';
import { handleIngestQueue } from '../../src/ingestion/queue-consumer';
import { normalizePosts } from '../../src/normalization/post-normalizer';
import { SEARCH_TIMEOUT_MS, STARTING_TIMEOUT_MS } from '../../src/search/manual-search';
import { IngestRunsRepository } from '../../src/storage/ingest-runs.repository';
import { PostsRepository } from '../../src/storage/posts.repository';
import { RUN_SEARCH_SCRIPT, RUN_SEARCH_SCRIPT_HASH } from '../../src/views/dashboard';
import { createApp } from '../../src/worker';
import {
  APIFY_TOKEN,
  basicAuthHeader,
  executionCtx,
  fakeApify,
  fakeBatch,
  fakeMessage,
  fakeQueue,
  itemsWithText,
  manyItems,
  US_JOB,
  resetDb,
  TEST_TASK_ID,
  testEnv,
  WEBHOOK_SECRET,
  webhookPayload,
  type FakeApify,
} from '../helpers';

// 2026-10-04 10:00 IST: "today" in Asia/Kolkata is 2026-10-04.
const NOW = new Date('2026-10-04T04:30:00.000Z');
const ORIGIN = 'https://scanner.example.workers.dev';
const DAY_MS = 86_400_000;

let apify: FakeApify;
let queue: ReturnType<typeof fakeQueue>;
let clock: Date;

const app = createApp({ fetch: (input, init) => apify.fetch(input, init), now: () => clock });

beforeEach(async () => {
  await resetDb();
  apify = fakeApify();
  queue = fakeQueue();
  clock = NOW;
});

/** Bindings of a configured Worker: the production Task id is set. */
const workerEnv = (overrides: Partial<Env> = {}) =>
  testEnv({ APIFY_TASK_ID: TEST_TASK_ID, INGEST_QUEUE: queue.queue, ...overrides });

/** The dashboard's Run Search form post, as a browser on the dashboard's origin sends it. */
function postSearch(form: Record<string, string>, options: { headers?: Record<string, string>; env?: Partial<Env> } = {}) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: ORIGIN,
    'Sec-Fetch-Site': 'same-origin',
    Authorization: basicAuthHeader(),
    ...options.headers,
  };
  return app.request(
    `${ORIGIN}/search`,
    { method: 'POST', headers, body: new URLSearchParams(form).toString() },
    workerEnv(options.env),
    executionCtx,
  );
}

const get = (path: string) =>
  app.request(`${ORIGIN}${path}`, { headers: { Authorization: basicAuthHeader() } }, workerEnv(), executionCtx);

const location = (res: Response) => res.headers.get('Location');
const message = (res: Response) => new URL(location(res)!, ORIGIN).searchParams.get('search');
const searchRows = async () =>
  (await env.DB.prepare('SELECT * FROM search_runs ORDER BY id').all<SearchRun>()).results;
const ingestRun = (apifyRunId: string) => new IngestRunsRepository(env.DB).findByApifyRunId(apifyRunId);
const lastStartedRunId = () => apify.startedRuns.at(-1)!.runId;

/** Apify finishes the run and delivers the Task's SUCCEEDED webhook. */
async function deliverWebhook(runId: string, items: unknown[]) {
  const run = apify.runs.get(runId)!;
  run.status = 'SUCCEEDED';
  run.items = items;
  const res = await app.request(
    '/webhooks/apify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [WEBHOOK_SECRET_HEADER]: WEBHOOK_SECRET },
      body: JSON.stringify(webhookPayload(runId)),
    },
    workerEnv(),
    executionCtx,
  );
  expect(res.status).toBe(200);
}

/** Delivers every queued page to the consumer, like the Queues runtime. */
async function drainQueue() {
  for (let guard = 0; queue.sent.length > 0 && guard < 100; guard++) {
    const delivered = fakeMessage(queue.sent.shift());
    await handleIngestQueue(fakeBatch([delivered]), workerEnv(), { fetch: apify.fetch, now: () => clock });
    expect(delivered.acked()).toBe(true);
  }
}

async function completeRun(runId: string, items: unknown[]): Promise<IngestRun> {
  await deliverWebhook(runId, items);
  await drainQueue();
  return (await ingestRun(runId))!;
}

/** Sets an item's LinkedIn post time. */
function postedAt(item: Record<string, unknown>, iso: string) {
  item.postedAt = { timestamp: Date.parse(iso), date: iso };
}

describe('POST /search — time windows', () => {
  it('runs the Task once with postedLimit 24h, week or month for Past 24 hours, 7 days and 30 days', async () => {
    const windows = [
      ['24h', '24h', 1],
      ['week', 'week', 7],
      ['month', 'month', 30],
    ] as const;
    for (const [window, postedLimit, days] of windows) {
      await resetDb();
      apify = fakeApify();
      const res = await postSearch({ window });
      expect(res.status).toBe(303);
      expect(location(res)).toBe('/?search=started');

      expect(apify.startedRuns).toHaveLength(1);
      const [started] = apify.startedRuns;
      expect(started!.taskId).toBe(TEST_TASK_ID);
      // The current production configuration, with only the window overridden for this run.
      expect(started!.input).toEqual({ ...PRODUCTION_SEARCH_CONFIG, postedLimit });

      expect(await searchRows()).toEqual([
        {
          id: expect.any(Number),
          search_window: window,
          requested_from: new Date(NOW.getTime() - days * DAY_MS).toISOString(),
          requested_to: NOW.toISOString(),
          apify_run_id: started!.runId,
          status: 'started',
          error: null,
          started_at: NOW.toISOString(),
        },
      ]);
    }
  });

  it('runs a date range with postedLimit "any" and the Actor cutoff at the start of From (display time zone)', async () => {
    const res = await postSearch({ window: 'range', range_from: '2026-10-01', range_to: '2026-10-03' });
    expect(location(res)).toBe('/?search=started');
    expect(apify.startedRuns[0]!.input).toEqual({
      ...PRODUCTION_SEARCH_CONFIG,
      postedLimit: 'any',
      postedLimitDate: '2026-09-30T18:30:00.000Z', // 2026-10-01 00:00 IST
    });
    expect((await searchRows())[0]).toMatchObject({
      search_window: 'range',
      requested_from: '2026-09-30T18:30:00.000Z',
      requested_to: '2026-10-03T18:30:00.000Z', // end of 2026-10-03 IST (exclusive)
      status: 'started',
    });
  });
});

describe('POST /search — validation', () => {
  it('rejects a date range with a missing (or malformed) date without calling Apify', async () => {
    const forms: Record<string, string>[] = [
      { window: 'range' },
      { window: 'range', range_from: '2026-10-01' },
      { window: 'range', range_to: '2026-10-03' },
      { window: 'range', range_from: '2026-02-30', range_to: '2026-10-03' },
    ];
    for (const form of forms) {
      const res = await postSearch(form);
      expect(res.status).toBe(303);
      expect(message(res)).toBe('missing_dates');
    }
    expect(apify.requests).toEqual([]);
    expect(await searchRows()).toEqual([]);
  });

  it('rejects From after To, keeping the chosen dates for the form', async () => {
    const res = await postSearch({ window: 'range', range_from: '2026-10-03', range_to: '2026-10-01' });
    expect(location(res)).toBe('/?search=from_after_to&window=range&range_from=2026-10-03&range_to=2026-10-01');
    expect(apify.requests).toEqual([]);
    expect(await searchRows()).toEqual([]);
  });

  it('rejects a To date in the future of the display time zone; today is allowed', async () => {
    expect(message(await postSearch({ window: 'range', range_from: '2026-10-01', range_to: '2026-10-05' }))).toBe(
      'future_to',
    );
    expect(apify.requests).toEqual([]);

    // 00:30 IST on 2026-10-05 (still the 4th in UTC): the 5th is today in Asia/Kolkata.
    clock = new Date('2026-10-04T19:00:00.000Z');
    expect(message(await postSearch({ window: 'range', range_from: '2026-10-05', range_to: '2026-10-05' }))).toBe(
      'started',
    );
  });

  it('rejects an unknown window', async () => {
    expect(message(await postSearch({ window: 'year' }))).toBe('invalid_window');
    expect(message(await postSearch({}))).toBe('invalid_window');
    expect(apify.requests).toEqual([]);
  });

  it('reports a Worker without the Apify Task configured, without calling Apify', async () => {
    const res = await postSearch({ window: '24h' }, { env: { APIFY_TASK_ID: '' } });
    expect(message(res)).toBe('not_configured');
    expect(apify.requests).toEqual([]);
    expect(await searchRows()).toEqual([]);
  });
});

describe('POST /search — access', () => {
  it('requires dashboard authentication: no search and no Apify call otherwise', async () => {
    const anonymous = await app.request(
      `${ORIGIN}/search`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
        body: 'window=24h',
      },
      workerEnv(),
      executionCtx,
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('WWW-Authenticate')).toContain('Basic');
    expect((await postSearch({ window: '24h' }, { headers: { Authorization: basicAuthHeader('admin', 'wrong') } })).status).toBe(401);
    // Fails closed when the dashboard credentials are not configured.
    expect((await postSearch({ window: '24h' }, { env: { DASHBOARD_PASSWORD: undefined } })).status).toBe(503);

    expect(apify.requests).toEqual([]);
    expect(await searchRows()).toEqual([]);
  });

  it('refuses cross-site form posts even with valid credentials (CSRF)', async () => {
    const crossSite = await postSearch(
      { window: '24h' },
      { headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } },
    );
    expect(crossSite.status).toBe(403);
    expect(apify.requests).toEqual([]);
    expect(await searchRows()).toEqual([]);
  });

  it('calls Apify with the Worker secret only; the token never reaches the browser', async () => {
    const res = await postSearch({ window: '24h' });
    expect(apify.authHeaders).toEqual([`Bearer ${APIFY_TOKEN}`]);
    expect(apify.calls.every((call) => !call.includes(APIFY_TOKEN))).toBe(true);
    expect(location(res)).not.toContain(APIFY_TOKEN);
    expect(await res.text()).not.toContain(APIFY_TOKEN);
    const page = await (await get('/')).text();
    expect(page).not.toContain(APIFY_TOKEN);
    expect(page).not.toContain(WEBHOOK_SECRET);
  });
});

describe('POST /search — one search at a time', () => {
  it('starts exactly one Apify run for duplicate simultaneous submissions', async () => {
    const responses = await Promise.all([postSearch({ window: '24h' }), postSearch({ window: '24h' })]);
    expect(responses.map(message).sort()).toEqual(['busy', 'started']);
    expect(apify.startedRuns).toHaveLength(1);
    expect(await searchRows()).toHaveLength(1);
  });

  it('refuses a new search until the running one is ingested', async () => {
    await postSearch({ window: '24h' });
    const runId = lastStartedRunId();
    expect(message(await postSearch({ window: 'week' }))).toBe('busy'); // Apify still running

    await deliverWebhook(runId, manyItems(30));
    expect((await ingestRun(runId))?.status).toBe('processing');
    expect(message(await postSearch({ window: 'week' }))).toBe('busy'); // results still being stored

    await drainQueue();
    expect(await ingestRun(runId)).toMatchObject({ status: 'succeeded', fetched: 30, new: 30, already_seen: 0 });
    expect(message(await postSearch({ window: 'week' }))).toBe('started');
    expect(apify.startedRuns).toHaveLength(2);
  });

  it('stops blocking after a timeout when a search never reports back', async () => {
    await postSearch({ window: '24h' }); // started; its webhook never arrives
    clock = new Date(NOW.getTime() + SEARCH_TIMEOUT_MS - 60_000);
    expect(message(await postSearch({ window: '24h' }))).toBe('busy');
    clock = new Date(NOW.getTime() + SEARCH_TIMEOUT_MS + 1_000);
    expect(message(await postSearch({ window: '24h' }))).toBe('started');

    // A search whose request died before Apify answered blocks only briefly.
    await resetDb();
    await env.DB.prepare(
      `INSERT INTO search_runs (search_window, requested_from, requested_to, status, started_at)
       VALUES ('24h', ?1, ?1, 'starting', ?1)`,
    )
      .bind(NOW.toISOString())
      .run();
    clock = new Date(NOW.getTime() + STARTING_TIMEOUT_MS - 1_000);
    expect(message(await postSearch({ window: '24h' }))).toBe('busy');
    clock = new Date(NOW.getTime() + STARTING_TIMEOUT_MS + 1_000);
    expect(message(await postSearch({ window: '24h' }))).toBe('started');
  });
});

describe('POST /search — Apify failures', () => {
  it('reports a run Apify refused, records it as failed and allows a retry', async () => {
    apify.failWith('/actor-tasks/', 402);
    const res = await postSearch({ window: 'month' });
    expect(location(res)).toBe('/?search=failed&window=month');
    expect(await searchRows()).toMatchObject([
      { search_window: 'month', status: 'failed', apify_run_id: null, error: 'Apify run task failed (HTTP 402)' },
    ]);

    apify = fakeApify(); // Apify accepts runs again
    expect(message(await postSearch({ window: 'month' }))).toBe('started');
  });

  it('marks a search failed when its Apify run fails, so it stops showing as in progress', async () => {
    await postSearch({ window: '24h' });
    apify.runs.get(lastStartedRunId())!.status = 'FAILED';

    const page = await (await get('/')).text();
    expect(page).not.toContain('Search in progress');
    expect((await searchRows())[0]).toMatchObject({ status: 'failed', error: 'Apify run failed' });
    expect(await (await get('/runs')).text()).toContain('Apify run failed');
    expect(message(await postSearch({ window: '24h' }))).toBe('started');
  });
});

describe('manual searches never schedule anything', () => {
  it('only starts single Task runs: no schedule is created and the Task is not modified', async () => {
    await postSearch({ window: 'month' });
    await postSearch({ window: 'month' }); // busy: no second call
    await completeRun(lastStartedRunId(), manyItems(10));
    await get('/');

    const writes = apify.requests.filter((request) => !request.startsWith('GET '));
    expect(writes).toEqual([`POST /actor-tasks/${TEST_TASK_ID}/runs`]);
    expect(apify.requests.some((request) => request.includes('/schedules'))).toBe(false);
  });
});

describe('date-range ingestion', () => {
  it('stores only posts posted inside the range; the others count as out of range, not as duplicates', async () => {
    // 2026-10-01 – 2026-10-02 in Asia/Kolkata = [2026-09-30T18:30Z, 2026-10-02T18:30Z).
    await postSearch({ window: 'range', range_from: '2026-10-01', range_to: '2026-10-02' });
    const items = manyItems(8);
    postedAt(items[0]!, '2026-09-30T18:30:00.000Z'); // first moment of Oct 1 IST: inside
    postedAt(items[1]!, '2026-10-01T12:00:00.000Z'); // inside (also stored by an earlier run)
    postedAt(items[2]!, '2026-10-02T18:29:59.999Z'); // last moment of Oct 2 IST: inside
    postedAt(items[3]!, '2026-10-01T00:00:00.000Z'); // inside
    postedAt(items[4]!, '2026-10-02T18:30:00.000Z'); // Oct 3 IST: after the range
    postedAt(items[5]!, '2026-10-04T03:00:00.000Z'); // today: after the range
    postedAt(items[6]!, '2026-09-30T18:29:59.999Z'); // Sep 30 IST: before the range
    delete items[7]!.postedAt; // no date: cannot be shown to be inside

    const earlier = await normalizePosts([items[1]], { fetchedAt: NOW.toISOString(), apifyRunId: 'RunEarlier0000001' });
    await new PostsRepository(env.DB).insertMany(earlier.posts);

    const run = await completeRun(lastStartedRunId(), [...items, { content: 'hiring, but no identity', job: US_JOB }]);
    expect(run).toMatchObject({ status: 'succeeded', fetched: 9, new: 3, already_seen: 1, invalid: 1, out_of_range: 4, dropped_no_hiring: 0 });

    const { results } = await env.DB.prepare('SELECT source_id FROM raw_posts ORDER BY source_id').all<{ source_id: string }>();
    expect(results.map((row) => row.source_id)).toEqual([0, 1, 2, 3].map((i) => `li:${String(items[i]!.id)}`));
  });

  it('stores a post only if it mentions hiring AND was posted inside the range; each reason is counted once', async () => {
    // 2026-10-01 – 2026-10-02 in Asia/Kolkata = [2026-09-30T18:30Z, 2026-10-02T18:30Z).
    await postSearch({ window: 'range', range_from: '2026-10-01', range_to: '2026-10-02' });
    const items = itemsWithText(['We are hiring', 'Also hiring', 'Join our team', 'Open role available']);
    postedAt(items[0]!, '2026-10-01T12:00:00.000Z'); // hiring, inside: stored
    postedAt(items[1]!, '2026-10-04T03:00:00.000Z'); // hiring, after the range: out of range
    postedAt(items[2]!, '2026-10-01T12:00:00.000Z'); // no hiring, inside: dropped (not out of range)
    postedAt(items[3]!, '2026-10-04T03:00:00.000Z'); // no hiring, outside: dropped (the filter runs first)

    const run = await completeRun(lastStartedRunId(), items);
    expect(run).toMatchObject({ status: 'succeeded', fetched: 4, new: 1, already_seen: 0, invalid: 0, out_of_range: 1, dropped_no_hiring: 2 });
    const { results } = await env.DB.prepare('SELECT source_id FROM raw_posts').all<{ source_id: string }>();
    expect(results.map((row) => row.source_id)).toEqual([`li:${String(items[0]!.id)}`]);
  });

  it('applies the hiring, US-job and date filters independently, counting each item once', async () => {
    // 2026-10-01 – 2026-10-02 in Asia/Kolkata = [2026-09-30T18:30Z, 2026-10-02T18:30Z).
    await postSearch({ window: 'range', range_from: '2026-10-01', range_to: '2026-10-02' });
    const [usInside, usOutside, noHiringOutside] = itemsWithText(['We are hiring', 'Also hiring', 'Join our team'], '79000000000');
    const [nonUsInside, nonUsOutside, unknownInside, unknownOutside] = itemsWithText(
      ['Hiring - London, UK', 'Hiring - Berlin, Germany', 'Hiring now', 'Hiring RevOps - Remote'],
      '79010000000',
      null,
    );
    const inside = '2026-10-01T12:00:00.000Z';
    const outside = '2026-10-04T03:00:00.000Z';
    postedAt(usInside!, inside); // stored
    postedAt(usOutside!, outside); // out of range
    postedAt(noHiringOutside!, outside); // no hiring (checked first)
    postedAt(nonUsInside!, inside); // non-US
    postedAt(nonUsOutside!, outside); // non-US (the location is checked before the date)
    postedAt(unknownInside!, inside); // location unknown
    postedAt(unknownOutside!, outside); // location unknown

    const run = await completeRun(lastStartedRunId(), [usInside, usOutside, noHiringOutside, nonUsInside, nonUsOutside, unknownInside, unknownOutside]);
    expect(run).toMatchObject({
      status: 'succeeded',
      fetched: 7,
      new: 1,
      already_seen: 0,
      invalid: 0,
      out_of_range: 1,
      dropped_no_hiring: 1,
      dropped_non_us: 2,
      dropped_location_unknown: 2,
    });
    const { results } = await env.DB.prepare('SELECT source_id FROM raw_posts').all<{ source_id: string }>();
    expect(results.map((row) => row.source_id)).toEqual([`li:${String(usInside!.id)}`]);
  });

  it('keeps every post of a relative window (the Actor applies the window)', async () => {
    await postSearch({ window: 'week' });
    const items = manyItems(3);
    postedAt(items[0]!, '2026-01-01T00:00:00.000Z');
    delete items[1]!.postedAt;
    const run = await completeRun(lastStartedRunId(), items);
    expect(run).toMatchObject({ status: 'succeeded', fetched: 3, new: 3, out_of_range: 0 });
  });
});

describe('GET / — Run Search', () => {
  it('offers the four windows (Past 24 hours by default) and the LinkedIn depth note', async () => {
    const body = await (await get('/')).text();
    expect(body).toContain('<form class="run-search" method="post" action="/search" novalidate>');
    for (const label of ['Past 24 hours', '7 days', '30 days', 'Date Range']) expect(body).toContain(`>${label}</label>`);
    expect(body).toContain('id="window-24h" value="24h" checked>');
    expect(body).toContain('name="range_from" value="" max="2026-10-04"');
    expect(body).toContain('name="range_to" value="" max="2026-10-04"');
    expect(body).toContain('Historical searches may be limited by LinkedIn search-result depth.');
    expect(body).toContain('Run Search</button>');
    expect(body).not.toContain('<fieldset disabled>');
    expect(body).not.toContain('http-equiv="refresh"');
    expect(body).not.toMatch(/schedul/i);
  });

  it('shows the outcome of a submission and fills a rejected range back in', async () => {
    const body = await (await get('/?search=from_after_to&window=range&range_from=2026-10-03&range_to=2026-10-01')).text();
    expect(body).toContain('The From date must be on or before the To date.');
    expect(body).toContain('id="window-range" value="range" checked>');
    expect(body).toContain('name="range_from" value="2026-10-03"');
    expect(body).toContain('name="range_to" value="2026-10-01"');
    // Unknown codes and malformed values are ignored.
    const ignored = await (await get('/?search=%3Cscript%3E&window=year&range_from=tomorrow')).text();
    expect(ignored).not.toContain('class="run-status');
    expect(ignored).toContain('id="window-24h" value="24h" checked>');
    expect(ignored).not.toContain('tomorrow');
  });

  it('while a search runs: shows its progress, disables the form and refreshes until the results are stored', async () => {
    await postSearch({ window: 'month' });
    const runId = lastStartedRunId();

    let body = await (await get('/?search=started')).text();
    expect(body).toContain('Search started.');
    expect(body).toContain('<strong>Search in progress</strong>');
    expect(body).toContain('30 days, started 2026-10-04 10:00. Apify is collecting posts.');
    expect(body).toContain('<fieldset disabled>');
    expect(body).toContain('id="window-month" value="month" checked>');
    // Reloads the page without the one-time message.
    expect(body).toContain('<meta http-equiv="refresh" content="15;url=/">');

    await deliverWebhook(runId, manyItems(30));
    body = await (await get('/?query=x')).text();
    expect(body).toContain('Storing the results.');
    expect(body).toContain('<meta http-equiv="refresh" content="15;url=/?query=x">');

    await drainQueue();
    body = await (await get('/')).text();
    expect(body).not.toContain('Search in progress');
    expect(body).not.toContain('http-equiv="refresh"');
    expect(body).not.toContain('<fieldset disabled>');
    expect(body).toMatch(/New<\/div><div class="value">30</);
  });

  it('shows a running date-range search with its dates', async () => {
    await postSearch({ window: 'range', range_from: '2026-10-01', range_to: '2026-10-03' });
    const body = await (await get('/')).text();
    expect(body).toContain('Oct 1 – Oct 3, started 2026-10-04 10:00.');
    expect(body).toContain('id="window-range" value="range" checked>');
    expect(body).toContain('name="range_from" value="2026-10-01"');
    expect(body).toContain('name="range_to" value="2026-10-03"');
  });

  it('allows exactly the Run Search script, by its hash', async () => {
    const res = await get('/');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RUN_SEARCH_SCRIPT));
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(RUN_SEARCH_SCRIPT_HASH).toBe(hash);
    expect(res.headers.get('Content-Security-Policy')).toMatch(new RegExp(`script-src 'sha256-${hash.replace(/[+/]/g, '\\$&')}'(;|$)`));
    const body = await res.text();
    expect(body).toContain(`<script>${RUN_SEARCH_SCRIPT}</script>`);
    expect(body.match(/<script/g)).toHaveLength(1);
  });
});

describe('GET /runs — search history', () => {
  it('lists each search with its window, status and counts, newest first', async () => {
    // A run ingested before Run Search existed: no search record; its window comes from its input.
    const runs = new IngestRunsRepository(env.DB);
    const legacy = (await runs.claim({
      apifyRunId: 'RunLegacy00000001',
      datasetId: 'DsLegacy000000001',
      queryConfigJson: JSON.stringify(PRODUCTION_SEARCH_CONFIG),
      pageSize: 25,
      now: '2026-10-03T03:31:00.000Z',
      staleBefore: '2000-01-01T00:00:00.000Z',
    }))!;
    await env.DB.batch([
      runs.recordPageStatement({ ingestRunId: legacy.id, offset: 0, fetched: 5, invalid: 0 }),
      runs.setPagesTotalStatement(legacy.id, 1),
    ]);
    await runs.finalizeIfComplete(legacy.id, '2026-10-03T03:32:00.000Z');

    clock = new Date('2026-10-04T04:00:00.000Z');
    await postSearch({ window: '24h' });
    await completeRun(lastStartedRunId(), manyItems(3));

    clock = new Date('2026-10-04T04:10:00.000Z');
    await postSearch({ window: 'range', range_from: '2026-10-01', range_to: '2026-10-03' });
    const rangeItems = manyItems(3, '78000000000'); // fixture posts: 2026-10-02, inside the range
    postedAt(rangeItems[2]!, '2026-10-04T03:00:00.000Z'); // today: outside
    await completeRun(lastStartedRunId(), rangeItems);

    clock = new Date('2026-10-04T04:20:00.000Z');
    apify = fakeApify();
    apify.failWith('/actor-tasks/', 500);
    await postSearch({ window: 'week' });

    clock = NOW;
    apify = fakeApify();
    await postSearch({ window: 'month' });

    const body = await (await get('/runs')).text();
    expect(body).toContain('Ingestion history');
    expect(body).toContain('<th>Search window</th><th>Status</th><th>Started</th><th>Completed</th>');
    expect(body).toContain('Duplicates</th>');
    expect(body).not.toContain('Already seen');
    expect(body).not.toMatch(/schedul/i);

    const order = ['30 days', '7 days', 'Oct 1 – Oct 3', 'Past 24 hours'].map((label) => body.indexOf(`<td class="window">${label}`));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Both the new 24h search and the older run are labelled "Past 24 hours".
    expect(body.split('<td class="window">Past 24 hours').length - 1).toBe(2);

    const rows = body.split('<tr>').slice(2); // skip the header row
    expect(rows[0]).toContain('badge status running');
    expect(rows[0]).toMatch(/(<td class="num">…<\/td>\s*){8}/);
    expect(rows[1]).toContain('badge status failed');
    expect(rows[1]).toContain('Apify run task failed (HTTP 500)');
    expect(rows[1]).toMatch(/(<td class="num">—<\/td>\s*){8}/);
    expect(rows[2]).toContain('badge status succeeded');
    // Fetched, new, duplicates, no hiring, non-US, location unknown, out of range, invalid.
    expect(rows[2]).toMatch(/<td class="num">3<\/td>\s*<td class="num">2<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">1<\/td>\s*<td class="num">0<\/td>/);
    expect(rows[3]).toMatch(/<td class="num">3<\/td>\s*<td class="num">3<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>/);
    expect(rows[4]).toContain('RunLegacy00000001');
    expect(rows[4]).toMatch(/<td class="num">5<\/td>\s*<td class="num">0<\/td>\s*<td class="num">5<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>/);
  });

  it('labels a search that never reported back as unknown', async () => {
    await postSearch({ window: '24h' });
    clock = new Date(NOW.getTime() + SEARCH_TIMEOUT_MS + 1_000);
    const body = await (await get('/runs')).text();
    expect(body).toContain('badge status unknown');
    expect(body).toContain('No results arrived from Apify within 30 minutes.');
  });
});
