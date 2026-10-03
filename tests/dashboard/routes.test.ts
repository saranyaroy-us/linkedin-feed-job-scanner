import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/config/env';
import { clearExpiredRawJson } from '../../src/maintenance/raw-json-retention';
import { normalizePosts } from '../../src/normalization/post-normalizer';
import { IngestRunsRepository } from '../../src/storage/ingest-runs.repository';
import { PostsRepository } from '../../src/storage/posts.repository';
import { createApp } from '../../src/worker';
import { basicAuthHeader, CONTEXT, executionCtx, loadSampleItems, resetDb, testEnv } from '../helpers';

// 2026-10-03 09:05 IST: "today" in Asia/Kolkata starts at 2026-10-02T18:30Z.
const NOW = new Date('2026-10-03T03:35:00.000Z');
const SALES = '"Sales Operations" OR "Sales Ops"';

const app = createApp({ now: () => NOW });

function get(path: string, options: { auth?: string | null; env?: Partial<Env> } = {}) {
  const headers: Record<string, string> = {};
  const auth = options.auth === undefined ? basicAuthHeader() : options.auth;
  if (auth) headers.Authorization = auth;
  return app.request(`https://scanner.example.workers.dev${path}`, { headers }, testEnv(options.env), executionCtx);
}

beforeEach(async () => {
  await resetDb();
  const { posts } = await normalizePosts(loadSampleItems(), CONTEXT);
  await new PostsRepository(env.DB).insertMany(posts);
  // created_at chosen so "today" differs between IST (starts 2026-10-02T18:30Z) and UTC (starts 2026-10-03T00:00Z):
  // today in IST: 101, 201, 401, 501 → 4;  today in UTC: 101, 401, 501 → 3.
  const createdAt: Record<string, string> = {
    'li:7500000000000000101': '2026-10-03T03:00:00.000Z',
    'li:7500000000000000201': '2026-10-02T20:00:00.000Z', // 01:30 IST on the 3rd, but the 2nd in UTC
    'li:7500000000000000301': '2026-10-02T18:00:00.000Z', // 23:30 IST on the 2nd
    'li:7500000000000000401': '2026-10-03T01:00:00.000Z',
    'li:7500000000000000501': '2026-10-03T02:00:00.000Z',
    'li:7500000000000000601': '2026-10-02T10:00:00.000Z',
  };
  await env.DB.batch(
    Object.entries(createdAt).map(([sourceId, at]) =>
      env.DB.prepare('UPDATE raw_posts SET created_at = ? WHERE source_id = ?').bind(at, sourceId),
    ),
  );
  const runs = new IngestRunsRepository(env.DB);
  const run = (await runs.claim({
    apifyRunId: CONTEXT.apifyRunId,
    datasetId: 'DsDashboard000001',
    queryConfigJson: JSON.stringify({ maxPosts: 100 }),
    pageSize: 50,
    now: '2026-10-03T03:31:00.000Z',
    staleBefore: '2000-01-01T00:00:00.000Z',
  }))!;
  await env.DB.batch([
    runs.recordPageStatement({ ingestRunId: run.id, offset: 0, fetched: 7, invalid: 1 }),
    runs.setPagesTotalStatement(run.id, 1),
  ]);
  await runs.finalizeIfComplete(run.id, '2026-10-03T03:32:00.000Z');
});

describe('access control', () => {
  it('requires Basic auth for the dashboard, runs and API', async () => {
    for (const path of ['/', '/runs', '/api/posts']) {
      const res = await get(path, { auth: null });
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
      expect((await get(path, { auth: basicAuthHeader('admin', 'wrong') })).status).toBe(401);
    }
  });

  it('fails closed (503) when dashboard credentials are not configured', async () => {
    const res = await get('/', { env: { DASHBOARD_PASSWORD: undefined } });
    expect(res.status).toBe(503);
  });

  it('keeps /health public and data-free', async () => {
    const res = await get('/health', { auth: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('exposes no other endpoints (no D1 management)', async () => {
    for (const path of ['/admin', '/api/sql', '/api/runs']) expect((await get(path)).status).toBe(404);
    const write = await app.request('https://x.workers.dev/api/posts', { method: 'DELETE', headers: { Authorization: basicAuthHeader() } }, testEnv(), executionCtx);
    expect(write.status).toBe(404);
  });

  it('sends security headers and marks authenticated pages uncacheable', async () => {
    const res = await get('/');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('GET / (dashboard)', () => {
  it('shows the stat cards', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Stored posts<\/div><div class="value">6</);
    expect(body).toMatch(/Added today<\/div><div class="value">4</);
    expect(body).toContain('2026-10-03 09:02'); // last ingestion, in IST
    expect(body).toMatch(/Last run fetched<\/div><div class="value">7</);
    expect(body).toMatch(/Last run new<\/div><div class="value">6</);
    expect(body).toMatch(/Last run duplicates<\/div><div class="value">0</);
    expect(body).toMatch(/Last run invalid<\/div><div class="value">1</);
  });

  it('"added today" follows DISPLAY_TIMEZONE', async () => {
    const utc = await (await get('/', { env: { DISPLAY_TIMEZONE: 'UTC' } })).text();
    expect(utc).toMatch(/Added today<\/div><div class="value">3</);
    expect(utc).toContain('Times in UTC');
  });

  it('shows posts per query and every post field', async () => {
    const body = await (await get('/')).text();
    expect(body).toContain('Posts per search query');
    expect(body).toContain('&quot;Sales Operations&quot; OR &quot;Sales Ops&quot;');
    expect(body).toContain('Sample Author Five');
    expect(body).toContain('>company<'); // author type
    expect(body).toContain('Repost');
    expect(body).toContain('Article: ');
    expect(body).toContain('2 likes<br>1 comments<br>0 shares');
    expect(body).toContain('https://www.linkedin.com/posts/sample-author-five_we-are-hiring-facility-officer-activity-7500000000000000501-TuVw');
    expect(body).toContain('2026-10-02 22:04'); // posted_at in IST
    expect(body).toContain('Showing 1–6 of 6 posts');
  });

  it('applies filters (query, author, author type, dates, text)', async () => {
    const byQuery = await (await get(`/?query=${encodeURIComponent(SALES)}`)).text();
    expect(byQuery).toContain('Showing 1–3 of 3 posts');
    const combined = await (await get(`/?query=${encodeURIComponent(SALES)}&q=chapter`)).text();
    expect(combined).toContain('Showing 1–1 posts');
    expect(combined).toContain('Sample Author Six');
    expect(await (await get('/?author_type=company')).text()).toContain('Example Data Co');
    expect(await (await get('/?author=nobody')).text()).toContain('No posts match these filters.');
    expect(await (await get('/?from=2026-10-03')).text()).toContain('No posts match these filters.');
  });

  it('ignores malformed or out-of-range filter values', async () => {
    const res = await get('/?from=2026-13-45&page=-4&author_type=robot');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Showing 1–6 of 6 posts');
    for (const query of ['to=9999-12-31', 'from=0001-01-01', 'to=9998-12-31']) {
      expect((await get(`/?${query}`)).status).toBe(200);
      expect((await get(`/api/posts?${query}`)).status).toBe(200);
    }
  });

  it('limits author/text searches without a "from" date to the last 90 days, and says so', async () => {
    const body = await (await get('/?q=chapter')).text();
    expect(body).toContain('Sample Author Six'); // posted 2026-10-02, inside the window
    expect(body).toContain('covers posts since 2026-07-05');
    // An explicit "from" overrides the window.
    expect(await (await get('/?q=chapter&from=2020-01-01')).text()).not.toContain('covers posts since');
    // Query-only filters are index-backed and not limited.
    expect(await (await get(`/?query=${encodeURIComponent(SALES)}`)).text()).not.toContain('covers posts since');
  });

  it('keeps undated posts searchable inside the default window', async () => {
    await env.DB.prepare("UPDATE raw_posts SET posted_at = NULL WHERE source_id = 'li:7500000000000000501'").run();
    expect(await (await get('/?author=Five')).text()).toContain('Sample Author Five');
    // An explicit date range means "dated posts in this range".
    expect(await (await get('/?author=Five&from=2026-01-01')).text()).toContain('No posts match these filters.');
  });

  it('shows "…" instead of zero counts while the latest run is still processing', async () => {
    await env.DB.prepare("UPDATE ingest_runs SET status = 'processing', completed_at = NULL").run();
    const body = await (await get('/')).text();
    expect(body).toMatch(/Last run fetched<\/div><div class="value">…</);
    expect(await (await get('/runs')).text()).toContain('<td class="num">…</td>');
  });

  it('excludes posts older than the default search window', async () => {
    await env.DB.prepare("UPDATE raw_posts SET posted_at = '2026-01-01T00:00:00.000Z' WHERE source_id = 'li:7500000000000000601'").run();
    expect(await (await get('/?q=chapter')).text()).toContain('No posts match these filters.');
    expect(await (await get('/?q=chapter&from=2025-12-01')).text()).toContain('Sample Author Six');
  });

  it('escapes post content', async () => {
    await env.DB.prepare("UPDATE raw_posts SET text = '<script>alert(1)</script>' WHERE source_id = 'li:7500000000000000501'").run();
    const body = await (await get('/')).text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('GET /runs', () => {
  it('lists ingestion history with status and counts', async () => {
    const body = await (await get('/runs')).text();
    expect(body).toContain('Ingestion history');
    expect(body).toContain(CONTEXT.apifyRunId);
    expect(body).toContain('https://console.apify.com/view/runs/' + CONTEXT.apifyRunId);
    expect(body).toContain('succeeded');
    expect(body).toMatch(/<td class="num">7<\/td>\s*<td class="num">6<\/td>\s*<td class="num">0<\/td>\s*<td class="num">1<\/td>/);
  });
});

describe('GET /api/posts', () => {
  it('returns normalized posts without raw_json by default', async () => {
    const res = await get(`/api/posts?query=${encodeURIComponent(SALES)}&limit=2`);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = (await res.json()) as { limit: number; has_more: boolean; posts: Record<string, unknown>[] };
    expect(json.limit).toBe(2);
    expect(json.has_more).toBe(true);
    expect(json.posts).toHaveLength(2);
    for (const post of json.posts) {
      expect(post).not.toHaveProperty('raw_json');
      expect(post).not.toHaveProperty('tagged_companies_json');
      expect(post).toHaveProperty('tagged_companies');
      expect(post).toHaveProperty('source_id');
    }
  });

  it('reports the default search window for author/text searches', async () => {
    const plain = (await (await get('/api/posts')).json()) as { search_window_from: string | null };
    expect(plain.search_window_from).toBeNull();
    const text = (await (await get('/api/posts?author=sample')).json()) as { search_window_from: string | null };
    expect(text.search_window_from).toBe('2026-07-05');
  });

  it('includes raw_json only with include_raw=1, with a smaller page cap', async () => {
    const json = (await (await get('/api/posts?include_raw=1&limit=100')).json()) as {
      limit: number;
      posts: { raw_json: string }[];
    };
    expect(json.limit).toBe(20);
    expect(typeof json.posts[0]!.raw_json).toBe('string');
  });

  it('serves posts whose raw_json was cleared by retention: raw_json null, normalized fields intact', async () => {
    const cleared = await clearExpiredRawJson(env.DB, new Date('2026-10-20T00:00:00.000Z'));
    expect(cleared.cleared).toBe(6);
    const json = (await (await get('/api/posts?include_raw=1')).json()) as { posts: Record<string, unknown>[] };
    expect(json.posts).toHaveLength(6);
    for (const post of json.posts) {
      expect(post.raw_json).toBeNull();
      expect(post.source_id).toMatch(/^li:/);
      expect(post.url).toMatch(/^https:\/\/www\.linkedin\.com\//);
      expect(post).toHaveProperty('tagged_companies');
    }
    expect((await get('/')).status).toBe(200);
  });

  it('caps limit and parses tagged companies', async () => {
    const json = (await (await get('/api/posts?limit=100000&author_type=company')).json()) as {
      limit: number;
      posts: { tagged_companies: unknown }[];
    };
    expect(json.limit).toBe(50); // out-of-range limit falls back to the default
    expect(json.posts[0]!.tagged_companies).toEqual([
      { id: '20000001', name: 'Example Data Co', linkedin_url: 'https://www.linkedin.com/company/example-data-co/' },
    ]);
  });
});
