import { html } from 'hono/html';
import { isHistoricalRun, type IngestRun } from '../domain/ingest-run';
import { formatInZone } from '../lib/time';
import type { SearchProgress } from '../search/manual-search';
import { externalLink, icon, layout, type Html } from './layout';
import { RUN_COUNTERS } from './run-counters';

const apifyRunUrl = (runId: string) => `https://console.apify.com/view/runs/${encodeURIComponent(runId)}`;

/** One search (or an older run without a search record) and its ingestion. */
export interface HistoryRow {
  /** "Past 24 hours", "7 days", "30 days", "Oct 1 – Oct 4", or "—" when unknown. */
  window: string;
  progress: SearchProgress;
  startedAt: string;
  apifyRunId: string | null;
  /** The ingestion of the run's results, once Apify's webhook delivered them. */
  run: IngestRun | null;
  error: string | null;
}

const HISTORICAL_NOTE =
  'Ingested before the hiring and US-job filters. Kept as an audit record; its posts are not in the US job list.';

const PROGRESS_ORDER: readonly SearchProgress[] = ['succeeded', 'starting', 'running', 'processing', 'failed', 'unknown'];
const IN_FLIGHT = new Set<SearchProgress>(['starting', 'running', 'processing']);

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function historyRow(row: HistoryRow, timeZone: string): Html {
  const { run } = row;
  // Counts are filled in when ingestion succeeds (or fails, with partial totals);
  // a historical run has no hard-filter counts (null).
  const count = (value: number | null | undefined) =>
    IN_FLIGHT.has(row.progress) ? '…' : run && value !== null ? (value ?? 0) : '—';
  const historical = run !== null && isHistoricalRun(run);
  return html`<tr${historical ? html` class="historical"` : ''}>
    <td class="window">${row.window}${historical
      ? html`<div><span class="badge historical" title="${HISTORICAL_NOTE}">Historical</span></div>`
      : ''}</td>
    <td class="status-cell">
      <span class="badge status ${row.progress}">${row.progress}</span>
      ${row.error ? html`<div class="run-error">${row.error}</div>` : ''}
    </td>
    <td class="when">${formatInZone(row.startedAt, timeZone)}</td>
    <td class="when">${formatInZone(run?.completed_at, timeZone)}</td>
    ${RUN_COUNTERS.map((counter) => html`<td class="num">${count(run ? counter.value(run) : undefined)}</td>`)}
    <td class="mono">${row.apifyRunId ? externalLink(apifyRunUrl(row.apifyRunId), row.apifyRunId) : '—'}</td>
    <td class="config">${run?.query_config_json
      ? html`<details><summary>Input</summary><pre>${prettyJson(run.query_config_json)}</pre></details>`
      : html`<span class="muted">—</span>`}</td>
  </tr>`;
}

export function runsPage(rows: HistoryRow[], timeZone: string): Html {
  const tallies = PROGRESS_ORDER.map((progress) => ({
    progress,
    count: rows.filter((row) => row.progress === progress).length,
  })).filter((tally) => tally.count > 0);
  return layout({
    title: 'Ingest runs · LinkedIn Job Signals',
    active: 'runs',
    timeZone,
    body: html`
    <div class="page-head">
      <div>
        <h2>Ingestion history</h2>
        <p>${rows.length
          ? `Latest ${rows.length} ${rows.length === 1 ? 'search' : 'searches'}, newest first. Counts appear once ingestion finishes.`
          : 'Searches appear here once started.'}${rows.some((row) => row.run !== null && isHistoricalRun(row.run))
          ? ` Historical runs ran before the hiring and US-job filters and are kept as audit records.`
          : ''}</p>
      </div>
      ${tallies.length
        ? html`<div class="chips">${tallies.map(
            (tally) => html`<span class="badge status ${tally.progress}">${tally.count} ${tally.progress}</span>`,
          )}</div>`
        : ''}
    </div>
    ${rows.length
      ? html`<section class="card table-card"><div class="table-scroll"><table class="runs">
          <thead><tr>
            <th>Search window</th><th>Status</th><th>Started</th><th>Completed</th>
            ${RUN_COUNTERS.map(
              (counter) => html`<th class="num" title="${counter.title}"><span class="dot tone-${counter.tone}"></span>${counter.label}</th>`,
            )}
            <th>Apify run ID</th><th>Input</th>
          </tr></thead>
          <tbody>${rows.map((row) => historyRow(row, timeZone))}</tbody>
        </table></div></section>`
      : html`<section class="card"><div class="empty">${icon('inbox', 28)}<p>No searches yet. Start one with Run search on the Posts page.</p></div></section>`}
    `,
  });
}
