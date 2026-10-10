import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/config/env';
import { SEARCH_QUERIES } from '../../src/config/search-config';
import { clearExpiredRawJson } from '../../src/maintenance/raw-json-retention';
import { normalizePosts } from '../../src/normalization/post-normalizer';
import { IngestRunsRepository } from '../../src/storage/ingest-runs.repository';
import { PostsRepository } from '../../src/storage/posts.repository';
import { createApp } from '../../src/worker';
import { asUsPosts, basicAuthHeader, CONTEXT, executionCtx, loadSampleItems, manyItems, resetDb, testEnv } from '../helpers';

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
  await new PostsRepository(env.DB).insertMany(asUsPosts(posts));
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
    expect(body).toMatch(/Fetched<\/div><div class="value">7</);
    expect(body).toMatch(/New<\/div><div class="value">6</);
    expect(body).toMatch(/Duplicates<\/div><div class="value">0</);
    expect(body).toMatch(/Invalid<\/div><div class="value">1</);
  });

  it('"added today" follows DISPLAY_TIMEZONE', async () => {
    const utc = await (await get('/', { env: { DISPLAY_TIMEZONE: 'UTC' } })).text();
    expect(utc).toMatch(/Added today<\/div><div class="value">3</);
    expect(utc).toContain('Times in UTC');
  });

  it('shows posts per query and the posts with their job details', async () => {
    const body = await (await get('/')).text();
    expect(body).toContain('Posts per search query');
    expect(body).toContain('FACILITY OFFICER'); // job title from the post text
    expect(body).toContain('Principal System &amp; App Admin');
    expect(body).toContain('Sample Author Five');
    expect(body).toContain('Senior HR Consultant'); // author info
    expect(body).toContain('Repost');
    expect(body).not.toContain('<th>Engagement</th>');
    expect(body).not.toMatch(/\d+ likes|\d+ comments|\d+ shares/);
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

  it('limits company/author/text searches without a "from" date to the last 90 days, and says so', async () => {
    const body = await (await get('/?q=chapter')).text();
    expect(body).toContain('Sample Author Six'); // posted 2026-10-02, inside the window
    expect(body).toContain('Company, author and text searches cover posts since 2026-07-05');
    expect(await (await get('/?company=example')).text()).toContain('cover posts since 2026-07-05');
    // An explicit "from" overrides the window.
    expect(await (await get('/?q=chapter&from=2020-01-01')).text()).not.toContain('cover posts since');
    // Index-backed filters (query, work mode) are not limited.
    expect(await (await get(`/?query=${encodeURIComponent(SALES)}`)).text()).not.toContain('cover posts since');
    expect(await (await get('/?work_mode=remote')).text()).not.toContain('cover posts since');
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
    expect(body).toMatch(/Fetched<\/div><div class="value">…</);
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

describe('GET / — dashboard queries, KPI cards and filter toolbar', () => {
  const escaped = (query: string) => query.replace(/"/g, '&quot;');
  const section = (body: string, start: string, end: string) => body.slice(body.indexOf(start), body.indexOf(end, body.indexOf(start)));
  const selectOptions = (body: string) =>
    [...section(body, '<select name="query">', '</select>').matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  const cardRows = (body: string) =>
    [...section(body, '<ul class="qlist">', '</ul>').matchAll(/<span class="dot"><\/span><span>([^<]*)<\/span><\/span><span class="qcount num">(\d+)</g)].map(
      (m) => [m[1], Number(m[2])],
    );
  const SALES_OPS_HIRING = '"Sales Ops" AND "hiring"';

  it('lists exactly the seven dashboard queries, in order, in the filter and the per-query card', async () => {
    const body = await (await get('/')).text();
    expect(selectOptions(body)).toEqual(['', ...SEARCH_QUERIES.map(escaped)]);
    // The fixture posts are stored under older query values: those are not listed, so every count is 0 …
    expect(cardRows(body)).toEqual(SEARCH_QUERIES.map((query) => [escaped(query), 0]));
    expect(section(body, '<ul class="qlist">', '</ul>')).toContain('style="width: 0%"');
    for (const old of [SALES, '"Revenue Operations" OR RevOps', '"Vendor Manager" OR "Vendor Management"']) {
      expect(section(body, '<select name="query">', '</select>')).not.toContain(escaped(old));
      expect(section(body, '<ul class="qlist">', '</ul>')).not.toContain(escaped(old));
    }
    // … but they stay in D1, in the totals and in the posts table.
    expect(body).toMatch(/Stored posts<\/div><div class="value">6</);
    expect(body).toContain('Showing 1–6 of 6 posts');
    expect(await (await get(`/?query=${encodeURIComponent(SALES)}`)).text()).toContain('Showing 1–3 of 3 posts');
  });

  it('counts and filters posts stored under a dashboard query', async () => {
    const items = manyItems(2, '79000000000').map((item) => ({ ...item, query: { ...(item.query as object), search: SALES_OPS_HIRING } }));
    const { posts } = await normalizePosts(items, CONTEXT);
    await new PostsRepository(env.DB).insertMany(asUsPosts(posts));

    const body = await (await get('/')).text();
    expect(cardRows(body)).toEqual(SEARCH_QUERIES.map((query) => [escaped(query), query === SALES_OPS_HIRING ? 2 : 0]));
    expect(section(body, '<ul class="qlist">', '</ul>')).toContain('style="width: 100%"');
    expect(body).toMatch(/Stored posts<\/div><div class="value">8</);

    const filtered = await (await get(`/?query=${encodeURIComponent(SALES_OPS_HIRING)}`)).text();
    expect(filtered).toContain('Showing 1–2 of 2 posts');
    expect(filtered).toContain(`<option value="${escaped(SALES_OPS_HIRING)}" selected>`);
  });

  it('renders the filters as one toolbar: query, company, work mode, author, from, to, text, Filter, Reset', async () => {
    const form = section(await (await get('/')).text(), '<form class="filters"', '</form>');
    const order = [
      'f-query">Search query', 'f-company">Company', 'f-mode">Work mode', 'f-author">Author',
      'f-date">Posted from', 'f-date">Posted to', 'f-text">Post text', 'Filter</button>', 'Reset</a>',
    ];
    const positions = order.map((marker) => form.indexOf(marker));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(form).not.toContain('Author type');
    expect([...section(form, '<select name="work_mode">', '</select>').matchAll(/<option value="([^"]*)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]])).toEqual([
      ['', 'Any'], ['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site'],
    ]);
  });

  it('filters by company (substring) and work mode, and keeps both in the page links', async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE raw_posts SET work_mode = 'remote' WHERE source_id IN ('li:7500000000000000101', 'li:7500000000000000401')"),
      env.DB.prepare("UPDATE raw_posts SET work_mode = 'hybrid' WHERE source_id = 'li:7500000000000000501'"),
    ]);
    const remote = await (await get('/?work_mode=remote')).text();
    expect(remote).toContain('Showing 1–2 posts');
    expect(remote).toContain('<option value="remote" selected>Remote</option>');
    expect(await (await get('/?work_mode=onsite')).text()).toContain('No posts match these filters.');
    const company = await (await get('/?company=DATA%20co')).text();
    expect(company).toContain('Showing 1–2 posts'); // the company author and the post tagging it
    expect(company).toContain('name="company" value="DATA co"');
    expect(await (await get('/?company=data&work_mode=remote')).text()).toContain('No posts match these filters.');
    expect(await (await get('/?work_mode=robot')).text()).toContain('Showing 1–6 of 6 posts'); // invalid values are ignored
  });

  it('keeps the KPI cards in two rows and the last ingestion on one compact line', async () => {
    const stats = section(await (await get('/')).text(), '<section class="stats">', '</section>');
    const labels = [...stats.matchAll(/<div class="label">([^<]+)<\/div>/g)].map((m) => m[1]);
    expect(labels).toEqual(['Stored posts', 'Added today', 'Last ingestion']);
    const lastRun = section(await (await get('/')).text(), '<section class="run-stats"', '</section>');
    expect(lastRun).toContain('<h2 class="stats-caption" id="last-run-title">Last run</h2>');
    expect([...lastRun.matchAll(/<div class="label">([^<]+)<\/div>/g)].map((m) => m[1])).toEqual([
      'Fetched', 'New', 'Duplicates', 'No hiring', 'Non-US', 'Loc. unknown', 'Out of range', 'Invalid',
    ]);
    expect(stats).toContain(
      `<div class="value-row"><div class="value small">2026-10-03 09:02</div><div class="sub"><span class="badge status succeeded">succeeded</span><span class="mono">${CONTEXT.apifyRunId}</span></div></div>`,
    );
  });
});

describe('GET / — Post column snippet', () => {
  const numbered = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join(' ');
  const setText = (sourceId: string, text: string) =>
    env.DB.prepare('UPDATE raw_posts SET text = ? WHERE source_id = ?').bind(text, sourceId).run();

  it('shows 18 words around the first "hiring", highlighted, with the full text behind "Show full text"', async () => {
    const text = `${numbered('b', 25)}\n\nWe are HIRING a Revenue Operations Manager!\n${numbered('a', 25)}\n\nApply: hiring@example.com`;
    await setText('li:7500000000000000501', text);
    const body = await (await get('/')).text();

    // b10…b25 + "We are" = 18 words before; "a Revenue Operations Manager!" + a1…a14 = 18 after.
    const before = `…${numbered('b', 25).split(' ').slice(9).join(' ')} We are `;
    const after = ` a Revenue Operations Manager! ${numbered('a', 14)}…`;
    expect(body).toContain(`<div class="text snippet">${before}<mark>HIRING</mark>${after}</div>`);
    // Expanding shows the complete text, line breaks and all, with labels for both states.
    expect(body).toContain(
      `<details><summary><span class="show">Show full text</span><span class="hide">Hide full text</span></summary><div class="text">${text}</div></details>`,
    );
  });

  it('falls back to the first 36 words when the post does not mention hiring', async () => {
    await setText('li:7500000000000000601', numbered('n', 40));
    const body = await (await get('/')).text();
    expect(body).toContain(`<div class="text snippet">${numbered('n', 36)}…</div>`);
    expect(body).toContain(`<div class="text">${numbered('n', 40)}</div></details>`);
  });

  it('shows a short post whole, without an expander', async () => {
    await setText('li:7500000000000000601', 'Short\n\npost   about RevOps.');
    const body = await (await get('/?author=Six')).text();
    expect(body).toContain('<div class="text snippet">Short post about RevOps.</div>');
    expect(body).not.toContain('<details>');
  });

  it('is display-only: stored text and the API keep the full post', async () => {
    const text = `${numbered('w', 30)} hiring ${numbered('x', 30)}`;
    await setText('li:7500000000000000501', text);
    expect((await get('/')).status).toBe(200);
    const stored = await env.DB.prepare("SELECT text FROM raw_posts WHERE source_id = 'li:7500000000000000501'").first<{ text: string }>();
    expect(stored?.text).toBe(text);
    const api = (await (await get('/api/posts?author=Five')).json()) as { posts: { text: string }[] };
    expect(api.posts[0]?.text).toBe(text);
  });

  it('escapes the snippet and the full text', async () => {
    await setText('li:7500000000000000501', `<b>We are hiring</b> ${numbered('z', 40)} <img src=x>`);
    const body = await (await get('/')).text();
    expect(body).toContain('&lt;b&gt;We are <mark>hiring</mark>&lt;/b&gt;');
    expect(body).not.toContain('<img src=x>');
  });
});

describe('GET / — posts table: job, company, location, posted by, links', () => {
  const JOB_URL = 'https://www.linkedin.com/jobs/view/4474331394/';
  const APPLY_URL = 'https://boards.greenhouse.io/acme/jobs/4474331394';
  const POST_URL = 'https://www.linkedin.com/posts/sample-author-five_we-are-hiring-facility-officer-activity-7500000000000000501-TuVw';
  const link = (href: string, label: string, className = 'action') =>
    `<a href="${href}" class="${className}" target="_blank" rel="noopener noreferrer">${label}`;
  const rows = (body: string) => body.slice(body.indexOf('<tbody>'), body.indexOf('</tbody>')).split('<tr>').slice(1);
  /** The table row of a fixture post, by its activity id ("501" → 7500000000000000501). */
  const rowOf = async (id: string) => rows(await (await get('/')).text()).find((r) => r.includes(`activity-7500000000000000${id}-`))!;
  const cell = (row: string, name: string) => row.match(new RegExp(`<td class="${name}" data-label="[^"]+">([\\s\\S]*?)</td>`))![1]!;

  beforeEach(async () => {
    await env.DB.prepare(
      `UPDATE raw_posts SET job_title = 'Revenue Operations Manager', company_name = 'Acme Corp',
         company_linkedin_url = 'https://www.linkedin.com/company/acme-corp/', job_location_text = 'Austin, Texas, United States',
         job_country = 'US', location_source = 'job', work_mode = 'hybrid', linkedin_job_url = ?, external_apply_url = ?
       WHERE source_id = 'li:7500000000000000501'`,
    )
      .bind(JOB_URL, APPLY_URL)
      .run();
  });

  it('has the compact columns: Posted, Job, Company, Location, Posted by, Post, Links', async () => {
    const body = await (await get('/')).text();
    expect(body).toContain('<thead><tr><th>Posted</th><th>Job</th><th>Company</th><th>Location</th><th>Posted by</th><th>Post</th><th>Links</th></tr></thead>');
    expect(body).not.toMatch(/<th>(?:Query|Engagement|LinkedIn)<\/th>/);
  });

  it('shows the job title, or "—"', async () => {
    expect(cell(await rowOf('501'), 'job')).toBe('Revenue Operations Manager');
    expect(cell(await rowOf('401'), 'job')).toBe('Principal System &amp; App Admin');
    expect(cell(await rowOf('101'), 'job')).toBe('<span class="muted">—</span>');
  });

  it('shows the company, linked to its LinkedIn page when known, or "—"', async () => {
    expect(cell(await rowOf('501'), 'company')).toBe(`${link('https://www.linkedin.com/company/acme-corp/', 'Acme Corp', 'company-name')}</a>`);
    await env.DB.prepare("UPDATE raw_posts SET company_linkedin_url = NULL WHERE source_id = 'li:7500000000000000501'").run();
    expect(cell(await rowOf('501'), 'company')).toBe('Acme Corp');
    expect(cell(await rowOf('101'), 'company')).toBe('<span class="muted">—</span>');
  });

  it('shows the location without the country, with a work-mode badge when known', async () => {
    expect(cell(await rowOf('501'), 'location')).toBe('<div>Austin, Texas</div><span class="badge mode hybrid">Hybrid</span>');
    await env.DB.batch([
      env.DB.prepare("UPDATE raw_posts SET job_location_text = 'United States', work_mode = 'remote' WHERE source_id = 'li:7500000000000000401'"),
      env.DB.prepare("UPDATE raw_posts SET job_location_text = NULL, work_mode = 'onsite' WHERE source_id = 'li:7500000000000000301'"),
    ]);
    expect(cell(await rowOf('401'), 'location')).toBe('<div>United States</div><span class="badge mode remote">Remote</span>');
    expect(cell(await rowOf('301'), 'location')).toBe('<span class="badge mode onsite">On-site</span>');
    // Unknown work mode: no badge; no location: "—".
    expect(cell(await rowOf('101'), 'location')).toBe('<span class="muted">—</span>');
  });

  it('shows who posted it: the name linked to the LinkedIn profile, and their info', async () => {
    const author = cell(await rowOf('501'), 'author');
    expect(author).toContain(`${link('https://www.linkedin.com/in/sample-author-five', 'Sample Author Five', 'author-name')}</a>`);
    expect(author).toContain('<div class="headline" title="Senior HR Consultant">Senior HR Consultant</div>');
    expect(author).not.toContain('badge'); // no author-type badge
  });

  it('shows View job, Apply and View post only when each link exists', async () => {
    const all = cell(await rowOf('501'), 'links');
    expect(all).toMatch(
      new RegExp(`^<div class="link-list">${escape(link(JOB_URL, 'View job'))}.*?</a>${escape(link(APPLY_URL, 'Apply'))}.*?</a>${escape(link(POST_URL, 'View post'))}.*?</a></div>$`),
    );
    // The fixture's lnkd.in "Apply at …" link; no LinkedIn job.
    const applyOnly = cell(await rowOf('401'), 'links');
    expect(applyOnly).toContain(link('https://lnkd.in/example4', 'Apply'));
    expect(applyOnly).not.toContain('View job');
    expect(applyOnly).toContain('View post');
    // Neither: just the post.
    const postOnly = cell(await rowOf('101'), 'links');
    expect(postOnly).not.toMatch(/View job|Apply/);
    expect(postOnly).toContain('View post');
    // No post URL either: "—" instead of a dead link.
    await env.DB.prepare("UPDATE raw_posts SET url = NULL WHERE source_id = 'li:7500000000000000101'").run();
    expect(cell(await rowOf('201'), 'links')).toContain('View post');
    const body = await (await get('/')).text();
    expect(rows(body).filter((r) => r.includes('<td class="links" data-label="Links"><span class="muted">—</span></td>'))).toHaveLength(1);
  });

  it('keeps the article line only for articles that are not the job link', async () => {
    // Fixture 301 links a job page, which is its Apply link: no separate article line.
    const job = cell(await rowOf('301'), 'post');
    expect(job).not.toContain('Article: ');
    expect(cell(await rowOf('301'), 'links')).toContain(link('https://jobs.example.com/acme-bio/product-marketing-manager', 'Apply'));
    await env.DB.prepare("UPDATE raw_posts SET external_apply_url = NULL WHERE source_id = 'li:7500000000000000301'").run();
    expect(cell(await rowOf('301'), 'post')).toContain('Article: <a href="https://jobs.example.com/acme-bio/product-marketing-manager"');
  });

  it('keeps the hiring-centered snippet in the Post column', async () => {
    const post = cell(await rowOf('501'), 'post');
    expect(post).toContain('<div class="text snippet">*WE ARE <mark>HIRING</mark>: FACILITY OFFICER*');
    expect(post).toContain('<summary><span class="show">Show full text</span><span class="hide">Hide full text</span></summary>');
  });

  it('cannot overflow the page horizontally: fixed column widths, wrapping cells, stacked rows on phones', async () => {
    const body = await (await get('/')).text();
    expect(body).toContain('<div class="table-scroll"><table class="posts">');
    expect(body).toContain('<colgroup><col class="c-when"><col class="c-job"><col class="c-company"><col class="c-location"><col class="c-author"><col class="c-post"><col class="c-links"></colgroup>');
    expect(body).toContain('.table-scroll { overflow-x: auto;');
    expect(body).toContain('table.posts { table-layout: fixed; }');
    expect(body).toContain('table.posts td { overflow-wrap: anywhere;');
    expect(body).toMatch(/@media \(max-width: 760px\) \{\s*table\.posts, table\.posts tbody, table\.posts tr, table\.posts td \{ display: block;/);
    for (const label of ['Posted', 'Job', 'Company', 'Location', 'Posted by', 'Post', 'Links']) {
      expect(body).toContain(`data-label="${label}"`);
    }
  });

  it('no longer renders the Engagement column (the counts stay stored)', async () => {
    const body = await (await get('/')).text();
    expect(body).not.toContain('Engagement');
    expect(body).not.toMatch(/\d+ likes|\d+ comments|\d+ shares/);
    expect(body).not.toContain('class="engage"');
    const { n } = (await env.DB.prepare('SELECT COUNT(*) AS n FROM raw_posts WHERE likes IS NOT NULL').first<{ n: number }>())!;
    expect(n).toBeGreaterThan(0);
  });
});

/** Escapes a literal for use inside a RegExp. */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

describe('GET /runs', () => {
  it('lists ingestion history with status and counts', async () => {
    const body = await (await get('/runs')).text();
    expect(body).toContain('Ingestion history');
    expect(body).toContain(CONTEXT.apifyRunId);
    expect(body).toContain('https://console.apify.com/view/runs/' + CONTEXT.apifyRunId);
    expect(body).toContain('succeeded');
    // Fetched, new, duplicates, no hiring, non-US, location unknown, out of range, invalid.
    expect(body).toMatch(
      /<td class="num">7<\/td>\s*<td class="num">6<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">1<\/td>/,
    );
  });

  it('shows every drop reason with a compact label and a tooltip', async () => {
    await env.DB.prepare(
      'UPDATE ingest_runs SET fetched = 20, dropped_no_hiring = 4, dropped_non_us = 3, dropped_location_unknown = 2, out_of_range = 1',
    ).run();
    const runs = await (await get('/runs')).text();
    for (const [label, title] of [
      ['No hiring', 'No hiring keyword'],
      ['Non-US', 'Job located outside the US'],
      ['Loc. unknown', 'Job location missing or ambiguous'],
      ['Out of range', 'Posted outside the date range'],
    ]) {
      expect(runs).toMatch(new RegExp(`<th class="num" title="${title}"><span class="dot tone-\\w+"></span>${label}</th>`));
    }
    expect(runs).toMatch(/<td class="num">20<\/td>\s*<td class="num">6<\/td>\s*<td class="num">0<\/td>\s*<td class="num">4<\/td>\s*<td class="num">3<\/td>\s*<td class="num">2<\/td>\s*<td class="num">1<\/td>\s*<td class="num">1<\/td>/);
    const dashboard = await (await get('/')).text();
    for (const [label, value, title] of [
      ['No hiring', 4, 'No hiring keyword'],
      ['Non-US', 3, 'Job located outside the US'],
      ['Loc. unknown', 2, 'Job location missing or ambiguous'],
      ['Out of range', 1, 'Posted outside the date range'],
    ]) {
      expect(dashboard).toMatch(new RegExp(`title="${title}"><span class="stat-icon">.*?</span><div class="label">${label}</div><div class="value">${value}<`));
    }
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

  it('returns every job detail field, null when unknown', async () => {
    const JOB_URL = 'https://www.linkedin.com/jobs/view/4474331394/';
    await env.DB.prepare(
      `UPDATE raw_posts SET linkedin_job_url = ?, job_location_text = 'Austin, TX', job_country = 'US', location_source = 'post_text',
         company_name = 'Acme Corp', company_linkedin_url = 'https://www.linkedin.com/company/acme-corp/', work_mode = 'remote',
         external_apply_url = 'https://jobs.lever.co/acme/1'
       WHERE source_id = ?`,
    )
      .bind(JOB_URL, 'li:7500000000000000501')
      .run();
    const json = (await (await get('/api/posts')).json()) as { posts: Record<string, unknown>[] };
    expect(json.posts).toHaveLength(6);
    const FIELDS = [
      'job_title', 'company_name', 'company_linkedin_url', 'job_location_text', 'job_country', 'work_mode',
      'location_source', 'linkedin_job_url', 'external_apply_url',
    ];
    for (const post of json.posts) for (const field of FIELDS) expect(post, field).toHaveProperty(field);
    const enriched = json.posts.find((post) => post.source_id === 'li:7500000000000000501');
    expect(enriched).toMatchObject({
      job_title: 'FACILITY OFFICER',
      company_name: 'Acme Corp',
      company_linkedin_url: 'https://www.linkedin.com/company/acme-corp/',
      job_location_text: 'Austin, TX',
      job_country: 'US',
      work_mode: 'remote',
      location_source: 'post_text',
      linkedin_job_url: JOB_URL,
      external_apply_url: 'https://jobs.lever.co/acme/1',
      url: 'https://www.linkedin.com/posts/sample-author-five_we-are-hiring-facility-officer-activity-7500000000000000501-TuVw',
    });
    // A US post with no other job details: nulls (work mode "unknown"); the existing fields are still there.
    expect(json.posts.find((post) => post.source_id === 'li:7500000000000000101')).toMatchObject({
      job_title: null,
      company_name: null,
      company_linkedin_url: null,
      job_location_text: null,
      job_country: 'US',
      work_mode: 'unknown',
      linkedin_job_url: null,
      external_apply_url: null,
      author_name: 'Sample Author One',
      likes: 4,
    });
  });

  it('lists only US job posts: unclassified (legacy) rows never appear', async () => {
    await env.DB.prepare("UPDATE raw_posts SET job_country = NULL, location_source = NULL WHERE source_id IN ('li:7500000000000000101', 'li:7500000000000000201')").run();
    const json = (await (await get('/api/posts')).json()) as { posts: { source_id: string; job_country: string }[] };
    expect(json.posts).toHaveLength(4);
    expect(json.posts.every((post) => post.job_country === 'US')).toBe(true);
    const page = await (await get('/')).text();
    expect(page).not.toContain('activity-7500000000000000101-');
    expect(page).not.toContain('activity-7500000000000000201-');
    expect(await (await get('/?author_type=company')).text()).toContain('No posts match these filters.');
  });

  it('filters by company and work mode', async () => {
    await env.DB.prepare("UPDATE raw_posts SET work_mode = 'hybrid' WHERE source_id = 'li:7500000000000000201'").run();
    const hybrid = (await (await get('/api/posts?work_mode=hybrid')).json()) as { posts: { source_id: string }[] };
    expect(hybrid.posts.map((post) => post.source_id)).toEqual(['li:7500000000000000201']);
    const company = (await (await get('/api/posts?company=example%20data')).json()) as { posts: unknown[]; search_window_from: string | null };
    expect(company.posts).toHaveLength(2);
    expect(company.search_window_from).toBe('2026-07-05');
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
