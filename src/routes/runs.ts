import type { Context } from 'hono';
import type { AppEnv } from '../config/env';
import type { IngestRun } from '../domain/ingest-run';
import type { SearchRun } from '../domain/search-run';
import { resolveTimeZone } from '../lib/time';
import { SEARCH_TIMEOUT_MS, searchProgress } from '../search/manual-search';
import { IngestRunsRepository } from '../storage/ingest-runs.repository';
import { SearchRunsRepository } from '../storage/search-runs.repository';
import { runsPage, type HistoryRow } from '../views/runs';
import { inputWindowLabel, searchWindowLabel } from '../views/search-window';

const RUNS_SHOWN = 60;

/** Why a search shows as "unknown": it never reported back. */
const UNKNOWN_REASONS = {
  starting: 'Apify did not confirm the run.',
  started: `No results arrived from Apify within ${SEARCH_TIMEOUT_MS / 60_000} minutes.`,
} as const;

/** GET /runs — searches and their ingestion, newest first. */
export function runsHandler(options: { now?: () => Date } = {}) {
  return async (c: Context<AppEnv>) => {
    const [searches, runs] = await Promise.all([
      new SearchRunsRepository(c.env.DB).list(RUNS_SHOWN),
      new IngestRunsRepository(c.env.DB).list(RUNS_SHOWN),
    ]);
    const timeZone = resolveTimeZone(c.env.DISPLAY_TIMEZONE);
    return c.html(runsPage(runHistory(searches, runs, options.now?.() ?? new Date(), timeZone), timeZone));
  };
}

/**
 * One row per search, with its ingestion once Apify's webhook delivered it,
 * plus ingested runs without a search record (started before Run Search
 * existed), newest first.
 */
function runHistory(searches: SearchRun[], runs: IngestRun[], now: Date, timeZone: string): HistoryRow[] {
  const runsByApifyId = new Map(runs.map((run) => [run.apify_run_id, run]));
  const linked = new Set<IngestRun>();
  const rows: HistoryRow[] = searches.map((search) => {
    const run = search.apify_run_id ? (runsByApifyId.get(search.apify_run_id) ?? null) : null;
    if (run) linked.add(run);
    const progress = searchProgress(search, run?.status ?? null, now);
    return {
      window: searchWindowLabel(search, timeZone),
      progress,
      startedAt: search.started_at,
      apifyRunId: search.apify_run_id,
      run,
      error:
        run?.error ??
        search.error ??
        (progress === 'unknown' && search.status !== 'failed' ? UNKNOWN_REASONS[search.status] : null),
    };
  });
  for (const run of runs) {
    if (linked.has(run)) continue;
    rows.push({
      window: inputWindowLabel(run.query_config_json),
      progress: run.status ?? 'unknown',
      startedAt: run.started_at,
      apifyRunId: run.apify_run_id,
      run,
      error: run.error,
    });
  }
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, RUNS_SHOWN);
}
