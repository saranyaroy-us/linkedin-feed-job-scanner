import { html } from 'hono/html';
import type { IngestRun } from '../domain/ingest-run';
import type { StoredRawPost } from '../domain/raw-post';
import { formatInZone } from '../lib/time';
import type { PostFilters, QueryCount } from '../storage/posts.repository';
import { externalLink, layout, statCard, type Html } from './layout';

const TEXT_PREVIEW_CHARS = 320;

export interface DashboardViewModel {
  timeZone: string;
  totalPosts: number;
  addedToday: number;
  latestRun: IngestRun | null;
  perQuery: QueryCount[];
  filters: PostFilters;
  /** Set when an author/text search was limited to recent posts because no "from" date was given. */
  searchWindowFrom: string | null;
  posts: StoredRawPost[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Exact match count when it is known without scanning; null otherwise. */
  matching: number | null;
}

const queryLabel = (query: string | null) => (query ? query : '(no query)');
/** Run counts are final once a run succeeds or fails; while processing they are not known yet. */
const runCount = (run: IngestRun | null, value: number | undefined) =>
  !run ? '—' : run.status === 'processing' ? '…' : (value ?? 0);
const num = (value: number | null) => (value === null ? '–' : String(value));

function postRow(post: StoredRawPost, timeZone: string): Html {
  const text = post.text ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();
  const isLong = flat.length > TEXT_PREVIEW_CHARS;
  return html`<tr>
    <td class="when">${formatInZone(post.posted_at, timeZone)}</td>
    <td class="query">${post.search_query ? html`<span class="badge query">${post.search_query}</span>` : '—'}</td>
    <td class="author">
      ${post.author_profile_url
        ? externalLink(post.author_profile_url, post.author_name ?? 'Unknown')
        : (post.author_name ?? 'Unknown')}
      <div><span class="badge">${post.author_type ?? 'unknown'}</span></div>
      ${post.author_headline ? html`<div class="headline">${post.author_headline}</div>` : ''}
    </td>
    <td class="post">
      ${post.repost_id ? html`<span class="badge repost">Repost</span>` : ''}
      ${isLong
        ? html`<div class="text">${flat.slice(0, TEXT_PREVIEW_CHARS)}…</div>
            <details><summary>Show full text</summary><div class="text">${text}</div></details>`
        : html`<div class="text">${flat || '(no text)'}</div>`}
      ${post.article_title
        ? html`<div class="article">Article: ${post.article_url
            ? externalLink(post.article_url, post.article_title)
            : post.article_title}</div>`
        : ''}
    </td>
    <td class="engage">${num(post.likes)} likes<br>${num(post.comments)} comments<br>${num(post.shares)} shares</td>
    <td>${post.url ? externalLink(post.url, 'Open ↗') : '—'}</td>
  </tr>`;
}

export function pageHref(filters: PostFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('query', filters.query);
  if (filters.author) params.set('author', filters.author);
  if (filters.authorType) params.set('author_type', filters.authorType);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.text) params.set('q', filters.text);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/?${qs}` : '/';
}

export function dashboardPage(vm: DashboardViewModel): Html {
  const run = vm.latestRun;
  const first = vm.posts.length === 0 ? 0 : (vm.page - 1) * vm.pageSize + 1;
  const last = (vm.page - 1) * vm.pageSize + vm.posts.length;
  const queries = vm.perQuery.filter((row) => row.search_query);

  return layout({
    title: 'LinkedIn Job Signals',
    active: 'posts',
    timeZone: vm.timeZone,
    body: html`
    <section class="stats">
      ${statCard('Stored posts', vm.totalPosts)}
      ${statCard('Added today', vm.addedToday)}
      ${statCard(
        'Last ingestion',
        run ? formatInZone(run.completed_at ?? run.started_at, vm.timeZone) : 'Never',
        run ? `${run.status ?? 'unknown'}${run.apify_run_id ? ` · ${run.apify_run_id}` : ''}` : undefined,
        true,
      )}
      ${statCard('Last run fetched', runCount(run, run?.fetched))}
      ${statCard('Last run new', runCount(run, run?.new))}
      ${statCard('Last run duplicates', runCount(run, run?.already_seen))}
      ${statCard('Last run invalid', runCount(run, run?.invalid))}
    </section>

    <section class="section card">
      <h2>Posts per search query</h2>
      ${vm.perQuery.length
        ? html`<ul class="qlist">${vm.perQuery.map(
            (row) =>
              html`<li><span>${queryLabel(row.search_query)}</span><span class="num">${row.posts}</span></li>`,
          )}</ul>`
        : html`<div class="sub">No posts yet. They arrive after the next scheduled Apify run.</div>`}
    </section>

    <form class="filters" method="get" action="/">
      <label>Search query
        <select name="query">
          <option value="">All queries</option>
          ${queries.map(
            (row) =>
              html`<option value="${row.search_query}" ${row.search_query === vm.filters.query ? 'selected' : ''}>${row.search_query}</option>`,
          )}
        </select>
      </label>
      <label>Author<input type="search" name="author" value="${vm.filters.author ?? ''}" placeholder="Name contains…"></label>
      <label>Author type
        <select name="author_type">
          <option value="">Any</option>
          <option value="profile" ${vm.filters.authorType === 'profile' ? 'selected' : ''}>Profile</option>
          <option value="company" ${vm.filters.authorType === 'company' ? 'selected' : ''}>Company</option>
        </select>
      </label>
      <label>Posted from<input type="date" name="from" value="${vm.filters.from ?? ''}"></label>
      <label>Posted to<input type="date" name="to" value="${vm.filters.to ?? ''}"></label>
      <label>Text<input type="search" name="q" value="${vm.filters.text ?? ''}" placeholder="Search post text…"></label>
      <button type="submit">Filter</button>
      <a class="btn secondary" href="/">Reset</a>
    </form>

    <p class="results">${vm.posts.length
      ? `Showing ${first}–${last}${vm.matching !== null ? ` of ${vm.matching}` : ''} posts, newest first`
      : ''}${vm.searchWindowFrom
      ? ` · Author/text search covers posts since ${vm.searchWindowFrom}; set “Posted from” to search further back.`
      : ''}</p>

    ${vm.posts.length
      ? html`<div class="table-scroll"><table>
          <thead><tr><th>Posted</th><th>Query</th><th>Author</th><th>Post</th><th>Engagement</th><th>LinkedIn</th></tr></thead>
          <tbody>${vm.posts.map((post) => postRow(post, vm.timeZone))}</tbody>
        </table></div>
        <div class="pager">
          ${vm.page > 1 ? html`<a class="btn secondary" href="${pageHref(vm.filters, vm.page - 1)}">← Newer</a>` : ''}
          ${vm.hasMore ? html`<a class="btn secondary" href="${pageHref(vm.filters, vm.page + 1)}">Older →</a>` : ''}
        </div>`
      : html`<div class="empty">No posts match these filters.</div>`}
    `,
  });
}
