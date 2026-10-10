import { html } from 'hono/html';
import type { IngestRun } from '../domain/ingest-run';
import type { StoredRawPost, WorkMode } from '../domain/raw-post';
import type { SearchWindow } from '../domain/search-run';
import { formatInZone } from '../lib/time';
import { canonicalLinkedinJobUrl } from '../normalization/job-links';
import type { SearchFormState, SearchMessage } from '../routes/run-search';
import type { PostFilters, QueryCount } from '../storage/posts.repository';
import { externalLink, icon, layout, statCard, type Html, type IconName, type Tone } from './layout';
import { postSnippet } from './post-snippet';
import { RUN_COUNTERS } from './run-counters';
import { WINDOW_LABELS } from './search-window';

/**
 * Run Search: on submit, disables the button and shows "Starting search…" so
 * the form cannot be sent twice (the server also refuses a second search while
 * one is in flight). A page restored from the back/forward cache gets its
 * button back. The CSP allows this script by RUN_SEARCH_SCRIPT_HASH only, so
 * any edit here must update the hash (a test checks it).
 */
export const RUN_SEARCH_SCRIPT = String.raw`(function () {
  var form = document.querySelector('form.run-search');
  if (!form) return;
  var button = form.querySelector('button[type="submit"]');
  var label = button.innerHTML;
  form.addEventListener('submit', function (event) {
    if (form.hasAttribute('data-busy')) { event.preventDefault(); return; }
    form.setAttribute('data-busy', '');
    button.disabled = true;
    button.textContent = 'Starting search\u2026';
  });
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    form.removeAttribute('data-busy');
    button.disabled = false;
    button.innerHTML = label;
  });
})();`;

/** Base64 SHA-256 of RUN_SEARCH_SCRIPT, for the CSP's script-src. */
export const RUN_SEARCH_SCRIPT_HASH = 'g/fqIfatT6PW1f9+Jwg66VotZTzzOFBInA4Z10DMIsE=';

const SEARCH_WINDOWS: readonly SearchWindow[] = ['24h', 'week', 'month', 'range'];

const SEARCH_MESSAGES: Record<SearchMessage, { tone: 'ok' | 'warn' | 'error'; text: string }> = {
  started: { tone: 'ok', text: 'Search started. New posts appear here once they are stored.' },
  busy: { tone: 'warn', text: 'A search is already in progress. Start another one when it has finished.' },
  invalid_window: { tone: 'error', text: 'Choose a time window for the search.' },
  missing_dates: { tone: 'error', text: 'Choose both a From and a To date for a date-range search.' },
  from_after_to: { tone: 'error', text: 'The From date must be on or before the To date.' },
  future_to: { tone: 'error', text: 'The To date cannot be in the future.' },
  not_configured: { tone: 'error', text: 'Search is not configured on the server (Apify token or task id missing).' },
  failed: { tone: 'error', text: 'The search could not be started. Try again in a few minutes.' },
};

const MESSAGE_ICONS: Record<'ok' | 'warn' | 'error', IconName> = { ok: 'check', warn: 'info', error: 'alert' };

const PROGRESS_TITLES: Record<SearchInFlight['progress'], string> = {
  starting: 'Starting search…',
  running: 'Search in progress',
  processing: 'Search in progress',
};
const PROGRESS_DETAILS: Record<SearchInFlight['progress'], string> = {
  starting: 'Waiting for Apify to accept the run.',
  running: 'Apify is collecting posts.',
  processing: 'Storing the results.',
};

/** The search in flight: Apify starting or running it, or its results being stored. */
export interface SearchInFlight {
  label: string;
  progress: 'starting' | 'running' | 'processing';
  startedAt: string;
}

export interface RunSearchViewModel {
  /** Message from the last submission, and the form values to show. */
  form: SearchFormState;
  inFlight: SearchInFlight | null;
  /** Today in the display zone: the latest day a range may end on. */
  today: string;
}

export interface DashboardViewModel {
  timeZone: string;
  totalPosts: number;
  addedToday: number;
  latestRun: IngestRun | null;
  /** Post counts of the production search queries (SEARCH_QUERIES), in order; 0 when none are stored. */
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
  runSearch: RunSearchViewModel;
}

/** Run counts are final once a run succeeds or fails; while processing they are not known yet. */
const runCount = (run: IngestRun | null, value: number | null | undefined) =>
  !run || value === null ? '—' : run.status === 'processing' ? '…' : (value ?? 0);

/** Colour family for a query's persona — purely visual, so query badges are easy to scan. */
function queryTone(query: string | null): Tone {
  const q = (query ?? '').toLowerCase();
  if (/revenue|revops/.test(q)) return 'blue';
  if (/sales/.test(q)) return 'teal';
  if (/vendor|supplier|third.party/.test(q)) return 'purple';
  return 'neutral';
}

const WORK_MODE_LABELS: Record<Exclude<WorkMode, 'unknown'>, string> = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };

/** Every stored job is in the US, so a trailing country adds nothing: "Plano, Texas, United States" → "Plano, Texas". */
const shortLocation = (text: string) => text.replace(/,\s*(?:united states(?: of america)?|usa|u\.s\.a?\.?|us)\s*$/i, '') || text;

const NONE = html`<span class="muted">—</span>`;

function postRow(post: StoredRawPost, timeZone: string): Html {
  const text = post.text ?? '';
  const snippet = postSnippet(text);
  const author = post.author_name ?? 'Unknown';
  const mode = post.work_mode && post.work_mode !== 'unknown' ? WORK_MODE_LABELS[post.work_mode] : null;
  // An article that is the job listing itself is already behind "View job" or "Apply".
  const articleIsJobLink =
    post.article_url !== null &&
    (post.article_url === post.external_apply_url || canonicalLinkedinJobUrl(post.article_url) !== null);
  const links = [
    post.linkedin_job_url ? externalLink(post.linkedin_job_url, html`View job${icon('external', 13)}`, 'action') : null,
    post.external_apply_url ? externalLink(post.external_apply_url, html`Apply${icon('external', 13)}`, 'action') : null,
    post.url ? externalLink(post.url, html`View post${icon('external', 13)}`, 'action') : null,
  ].filter((link) => link !== null);
  return html`<tr>
    <td class="when" data-label="Posted">${formatInZone(post.posted_at, timeZone)}</td>
    <td class="job" data-label="Job">${post.job_title ?? NONE}</td>
    <td class="company" data-label="Company">${post.company_name
      ? post.company_linkedin_url
        ? externalLink(post.company_linkedin_url, post.company_name, 'company-name')
        : post.company_name
      : NONE}</td>
    <td class="location" data-label="Location">${post.job_location_text
      ? html`<div>${shortLocation(post.job_location_text)}</div>`
      : mode ? '' : NONE}${mode ? html`<span class="badge mode ${post.work_mode}">${mode}</span>` : ''}</td>
    <td class="author" data-label="Posted by">
      ${post.author_profile_url
        ? externalLink(post.author_profile_url, author, 'author-name')
        : html`<span class="author-name">${author}</span>`}
      ${post.author_headline ? html`<div class="headline" title="${post.author_headline}">${post.author_headline}</div>` : ''}
    </td>
    <td class="post" data-label="Post">
      ${post.repost_id ? html`<span class="badge repost">Repost</span>` : ''}
      <div class="text snippet">${snippet.match === null
        ? snippet.before || '(no text)'
        : html`${snippet.before}<mark>${snippet.match}</mark>${snippet.after}`}</div>
      ${snippet.truncated
        ? html`<details><summary><span class="show">Show full text</span><span class="hide">Hide full text</span></summary><div class="text">${text}</div></details>`
        : ''}
      ${post.article_title && !articleIsJobLink
        ? html`<div class="article">Article: ${post.article_url
            ? externalLink(post.article_url, post.article_title)
            : post.article_title}</div>`
        : ''}
    </td>
    <td class="links" data-label="Links">${links.length ? html`<div class="link-list">${links}</div>` : NONE}</td>
  </tr>`;
}

function runSearchCard(vm: RunSearchViewModel, timeZone: string): Html {
  const { form, inFlight } = vm;
  const message = form.message ? SEARCH_MESSAGES[form.message] : null;
  const option = (window: SearchWindow) =>
    html`<input type="radio" name="window" id="window-${window}" value="${window}"${form.window === window ? ' checked' : ''}><label for="window-${window}">${WINDOW_LABELS[window]}</label>`;
  return html`<section class="card run-card" aria-labelledby="run-search-title">
      <form class="run-search" method="post" action="/search" novalidate>
        <fieldset${inFlight ? ' disabled' : ''}>
          <div class="run-row">
            <h2 class="card-title" id="run-search-title">${icon('search')}Run search</h2>
            <div class="segmented" role="radiogroup" aria-label="Search window">${SEARCH_WINDOWS.map(option)}</div>
            <div class="range-fields">
              <label class="inline-field">From<input type="date" name="range_from" value="${form.rangeFrom}" max="${vm.today}"></label>
              <label class="inline-field">To<input type="date" name="range_to" value="${form.rangeTo}" max="${vm.today}"></label>
            </div>
            <button type="submit" class="btn btn-primary">${inFlight ? 'Search in progress' : html`${icon('search', 16)}Run Search`}</button>
          </div>
          <p class="range-note">${icon('info', 14)}Historical searches may be limited by LinkedIn search-result depth.</p>
        </fieldset>
      </form>
      ${message
        ? html`<div class="run-status ${message.tone}" role="${message.tone === 'error' ? 'alert' : 'status'}">${icon(MESSAGE_ICONS[message.tone], 16)}<span class="detail">${message.text}</span></div>`
        : ''}
      ${inFlight
        ? html`<div class="run-status progress" role="status"><span class="spinner" aria-hidden="true"></span><strong>${PROGRESS_TITLES[inFlight.progress]}</strong><span class="detail">${inFlight.label}, started ${formatInZone(inFlight.startedAt, timeZone)}. ${PROGRESS_DETAILS[inFlight.progress]} This page refreshes until the results are stored.</span></div>`
        : ''}
    </section>`;
}

const isFiltered = (filters: PostFilters) => Object.values(filters).some((value) => value !== undefined && value !== '');

export function pageHref(filters: PostFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('query', filters.query);
  if (filters.company) params.set('company', filters.company);
  if (filters.workMode) params.set('work_mode', filters.workMode);
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
  const largest = Math.max(1, ...vm.perQuery.map((row) => row.posts));

  return layout({
    title: 'LinkedIn Job Signals',
    active: 'posts',
    timeZone: vm.timeZone,
    // While a search is in flight, reload (without the one-time message) until its results are stored.
    refreshUrl: vm.runSearch.inFlight ? pageHref(vm.filters, vm.page) : undefined,
    script: RUN_SEARCH_SCRIPT,
    body: html`
    <div class="page-head">
      <div><h2>Overview</h2><p>Ingestion health and the newest posts from the LinkedIn search queries.</p></div>
    </div>

    ${runSearchCard(vm.runSearch, vm.timeZone)}

    <section class="stats">
      ${statCard({ label: 'Stored posts', value: vm.totalPosts, tone: 'blue', icon: 'database' })}
      ${statCard({ label: 'Added today', value: vm.addedToday, tone: 'green', icon: 'calendar' })}
      ${statCard({
        label: 'Last ingestion',
        value: run ? formatInZone(run.completed_at ?? run.started_at, vm.timeZone) : 'Never',
        tone: 'purple',
        icon: 'clock',
        small: true,
        sub: run
          ? html`<span class="badge status ${run.status ?? ''}">${run.status ?? 'unknown'}</span>${run.apify_run_id
              ? html`<span class="mono">${run.apify_run_id}</span>`
              : ''}`
          : undefined,
      })}
    </section>

    <section class="run-stats" aria-labelledby="last-run-title">
      <h2 class="stats-caption" id="last-run-title">Last run</h2>
      <div class="run-grid">${RUN_COUNTERS.map((counter) =>
        statCard({
          label: counter.label,
          value: runCount(run, run ? counter.value(run) : undefined),
          tone: counter.tone,
          icon: counter.icon,
          title: counter.title,
        }),
      )}</div>
    </section>

    <section class="card query-card" aria-labelledby="query-counts-title">
      <h2 class="card-title" id="query-counts-title">${icon('list')}Posts per search query</h2>
      <ul class="qlist">${vm.perQuery.map(
        (row) => html`<li class="tone-${queryTone(row.search_query)}">
          <div class="qrow"><span class="qname"><span class="dot"></span><span>${row.search_query}</span></span><span class="qcount num">${row.posts}</span></div>
          <div class="qbar"><span style="width: ${row.posts ? Math.max(2, Math.round((row.posts / largest) * 100)) : 0}%"></span></div>
        </li>`,
      )}</ul>
    </section>

    <section class="card filter-card" aria-labelledby="filter-title">
      <h2 class="sr-only" id="filter-title">Filter posts</h2>
      <form class="filters" method="get" action="/">
        <label class="field f-query">Search query
          <select name="query">
            <option value="">All queries</option>
            ${vm.perQuery.map(
              (row) =>
                html`<option value="${row.search_query}" ${row.search_query === vm.filters.query ? 'selected' : ''}>${row.search_query}</option>`,
            )}
          </select>
        </label>
        <label class="field f-company">Company
          <input type="search" name="company" value="${vm.filters.company ?? ''}" placeholder="Contains…">
        </label>
        <label class="field f-mode">Work mode
          <select name="work_mode">
            <option value="">Any</option>
            ${(Object.keys(WORK_MODE_LABELS) as (keyof typeof WORK_MODE_LABELS)[]).map(
              (mode) => html`<option value="${mode}" ${vm.filters.workMode === mode ? 'selected' : ''}>${WORK_MODE_LABELS[mode]}</option>`,
            )}
          </select>
        </label>
        <label class="field f-author">Author
          <span class="input-icon">${icon('user', 16)}<input type="search" name="author" value="${vm.filters.author ?? ''}" placeholder="Contains…"></span>
        </label>
        <label class="field f-date">Posted from<input type="date" name="from" value="${vm.filters.from ?? ''}"></label>
        <label class="field f-date">Posted to<input type="date" name="to" value="${vm.filters.to ?? ''}"></label>
        <label class="field f-text">Post text
          <span class="input-icon">${icon('search', 16)}<input type="search" name="q" value="${vm.filters.text ?? ''}" placeholder="Search text…"></span>
        </label>
        <div class="filter-actions">
          <button type="submit" class="btn btn-primary">${icon('filter', 16)}Filter</button>
          <a class="btn btn-secondary" href="/">Reset</a>
        </div>
      </form>
    </section>

    <section class="card table-card">
      <div class="table-head">
        <h2>Posts</h2>
        <p class="results">${vm.posts.length
          ? `Showing ${first}–${last}${vm.matching !== null ? ` of ${vm.matching}` : ''} posts, newest first`
          : ''}</p>
      </div>
      ${vm.searchWindowFrom
        ? html`<div class="note">${icon('info', 16)}<span>Company, author and text searches cover posts since ${vm.searchWindowFrom}. Set “Posted from” to search further back.</span></div>`
        : ''}
      ${vm.posts.length
        ? html`<div class="table-scroll"><table class="posts">
            <colgroup><col class="c-when"><col class="c-job"><col class="c-company"><col class="c-location"><col class="c-author"><col class="c-post"><col class="c-links"></colgroup>
            <thead><tr><th>Posted</th><th>Job</th><th>Company</th><th>Location</th><th>Posted by</th><th>Post</th><th>Links</th></tr></thead>
            <tbody>${vm.posts.map((post) => postRow(post, vm.timeZone))}</tbody>
          </table></div>`
        : html`<div class="empty">${icon('inbox', 28)}<p>${isFiltered(vm.filters) || vm.page > 1
            ? 'No posts match these filters.'
            : 'No US hiring posts stored yet. Run a search to discover opportunities.'}</p></div>`}
    </section>
    ${vm.posts.length && (vm.page > 1 || vm.hasMore)
      ? html`<nav class="pager" aria-label="Pages">
          ${vm.page > 1 ? html`<a class="btn btn-secondary" href="${pageHref(vm.filters, vm.page - 1)}">← Newer</a>` : ''}
          ${vm.hasMore ? html`<a class="btn btn-secondary" href="${pageHref(vm.filters, vm.page + 1)}">Older →</a>` : ''}
        </nav>`
      : ''}
    `,
  });
}
