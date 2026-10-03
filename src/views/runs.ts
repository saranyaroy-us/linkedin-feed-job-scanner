import { html } from 'hono/html';
import type { IngestRun } from '../domain/ingest-run';
import { formatInZone } from '../lib/time';
import { externalLink, layout, type Html } from './layout';

const apifyRunUrl = (runId: string) => `https://console.apify.com/view/runs/${encodeURIComponent(runId)}`;

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function runRow(run: IngestRun, timeZone: string): Html {
  // Counts are filled in when a run succeeds (or fails, with partial totals).
  const count = (value: number) => (run.status === 'processing' ? '…' : value);
  return html`<tr>
    <td class="num">${run.id}</td>
    <td class="when">${formatInZone(run.started_at, timeZone)}</td>
    <td class="when">${formatInZone(run.completed_at, timeZone)}</td>
    <td>
      <span class="badge ${run.status ?? ''}">${run.status ?? 'unknown'}</span>
      ${run.error ? html`<div class="sub">${run.error}</div>` : ''}
    </td>
    <td class="mono">${run.apify_run_id ? externalLink(apifyRunUrl(run.apify_run_id), run.apify_run_id) : '—'}</td>
    <td class="num">${count(run.fetched)}</td>
    <td class="num">${count(run.new)}</td>
    <td class="num">${count(run.already_seen)}</td>
    <td class="num">${count(run.invalid)}</td>
    <td>${run.query_config_json
      ? html`<details><summary>Input</summary><pre>${prettyJson(run.query_config_json)}</pre></details>`
      : '—'}</td>
  </tr>`;
}

export function runsPage(runs: IngestRun[], timeZone: string): Html {
  return layout({
    title: 'Ingest runs · LinkedIn Job Signals',
    active: 'runs',
    timeZone,
    body: html`
    <h2>Ingestion history</h2>
    ${runs.length
      ? html`<div class="table-scroll"><table>
          <thead><tr>
            <th>#</th><th>Started</th><th>Completed</th><th>Status</th><th>Apify run ID</th>
            <th class="num">Fetched</th><th class="num">New</th><th class="num">Already seen</th>
            <th class="num">Invalid</th><th>Config</th>
          </tr></thead>
          <tbody>${runs.map((run) => runRow(run, timeZone))}</tbody>
        </table></div>`
      : html`<div class="empty">No ingestion runs yet. Runs appear when Apify delivers its SUCCEEDED webhook.</div>`}
    `,
  });
}
