import { ApifyApiError, type ApifyClient } from '../apify/client';
import {
  PRODUCTION_SEARCH_CONFIG,
  SearchConfigSchema,
  WINDOW_POSTED_LIMIT,
  type SearchConfig,
} from '../config/search-config';
import { SearchWindowSchema, type SearchRun, type SearchWindow } from '../domain/search-run';
import { dateInZone, endOfDayUtc, isYmd, startOfDayUtc } from '../lib/time';
import { SearchRunsRepository, type InFlightCutoffs, type SearchRunWithIngest } from '../storage/search-runs.repository';

/** A search still 'starting' after this is presumed dead (its request stopped before Apify answered). */
export const STARTING_TIMEOUT_MS = 2 * 60_000;

/**
 * A started search counts as in flight (shown as in progress, and blocking new
 * searches) until its ingestion finishes, or for at most this long — e.g. when
 * Apify's webhook never arrives.
 */
export const SEARCH_TIMEOUT_MS = 30 * 60_000;

const DAY_MS = 86_400_000;
const RELATIVE_WINDOW_MS = { '24h': DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS } as const;

/** The dashboard's check of a running search's Apify run must not hold up the page for long. */
const STATUS_CHECK_TIMEOUT_MS = 3_000;

/** Apify run statuses that end a run without results (no SUCCEEDED webhook will follow). */
const UNSUCCESSFUL_RUN_STATUSES = new Set(['FAILED', 'TIMED-OUT', 'ABORTED']);

/** A validated search: the window and the instants it covers, [from, to). */
export interface SearchRequest {
  window: SearchWindow;
  from: string;
  to: string;
}

export type SearchRequestError = 'invalid_window' | 'missing_dates' | 'from_after_to' | 'future_to';

export interface SearchForm {
  window?: string;
  range_from?: string;
  range_to?: string;
}

/**
 * Validates the Run Search form. Relative windows end now; a date range covers
 * whole days (YYYY-MM-DD, inclusive) in `timeZone` and must not end in the future.
 */
export function parseSearchRequest(
  form: SearchForm,
  now: Date,
  timeZone: string,
): { ok: true; request: SearchRequest } | { ok: false; error: SearchRequestError } {
  const window = SearchWindowSchema.safeParse(form.window);
  if (!window.success) return { ok: false, error: 'invalid_window' };
  if (window.data !== 'range') {
    const from = new Date(now.getTime() - RELATIVE_WINDOW_MS[window.data]);
    return { ok: true, request: { window: window.data, from: from.toISOString(), to: now.toISOString() } };
  }
  const from = form.range_from?.trim() ?? '';
  const to = form.range_to?.trim() ?? '';
  if (!isYmd(from) || !isYmd(to)) return { ok: false, error: 'missing_dates' };
  if (from > to) return { ok: false, error: 'from_after_to' };
  if (to > dateInZone(now, timeZone)) return { ok: false, error: 'future_to' };
  return {
    ok: true,
    request: { window: 'range', from: startOfDayUtc(from, timeZone), to: endOfDayUtc(to, timeZone) },
  };
}

/**
 * The Actor input for one search: the production configuration with the
 * window's postedLimit, or — for a date range — the Actor's historical cutoff
 * (postedLimitDate) at the start of the range.
 */
export function searchInput(request: SearchRequest): SearchConfig {
  return SearchConfigSchema.parse(
    request.window === 'range'
      ? { ...PRODUCTION_SEARCH_CONFIG, postedLimit: 'any', postedLimitDate: request.from }
      : { ...PRODUCTION_SEARCH_CONFIG, postedLimit: WINDOW_POSTED_LIMIT[request.window] },
  );
}

/** True when `postedAt` lies in [from, to). A post without a date is never inside a range. */
export function isPostedWithin(postedAt: string | null, range: { from: string; to: string }): boolean {
  if (!postedAt) return false;
  const time = Date.parse(postedAt);
  return time >= Date.parse(range.from) && time < Date.parse(range.to);
}

export function inFlightCutoffs(now: Date): InFlightCutoffs {
  return {
    startingAfter: new Date(now.getTime() - STARTING_TIMEOUT_MS).toISOString(),
    startedAfter: new Date(now.getTime() - SEARCH_TIMEOUT_MS).toISOString(),
  };
}

export interface ManualSearchDeps {
  db: D1Database;
  apify: ApifyClient;
  /** The Apify Task to run; its webhook delivers the results. */
  taskId: string;
  now?: () => Date;
}

export type StartSearchOutcome =
  | { kind: 'started'; apifyRunId: string }
  | { kind: 'busy' }
  | { kind: 'failed'; reason: string };

/**
 * Starts one search: records it (unless another search is in flight), then
 * runs the Apify Task once with the window as an input override. The Task's
 * stored input and any schedule stay untouched; the Task's webhook ingests the
 * results through the usual queue.
 */
export async function startManualSearch(request: SearchRequest, deps: ManualSearchDeps): Promise<StartSearchOutcome> {
  const searches = new SearchRunsRepository(deps.db);
  const now = deps.now?.() ?? new Date();
  const search = await searches.tryStart({
    window: request.window,
    requestedFrom: request.from,
    requestedTo: request.to,
    now: now.toISOString(),
    ...inFlightCutoffs(now),
  });
  if (!search) return { kind: 'busy' };

  let apifyRunId: string;
  try {
    apifyRunId = (await deps.apify.startTaskRun(deps.taskId, searchInput(request))).id;
  } catch (error) {
    const reason = error instanceof ApifyApiError ? error.message : 'the Apify run could not be started';
    await searches.markFailed(search.id, reason);
    return { kind: 'failed', reason };
  }
  try {
    await searches.markStarted(search.id, apifyRunId);
  } catch {
    // The run is running and its webhook will ingest it; only the link to this
    // search is missing (so a date range would not be filtered). Rare: D1 failed
    // right after answering tryStart.
    console.error(`search: run ${apifyRunId} started but could not be linked to search ${search.id}`);
  }
  return { kind: 'started', apifyRunId };
}

/**
 * The search in flight, if any. A started search whose Apify run already ended
 * without succeeding (so no webhook will come) is marked failed instead, so it
 * neither shows as in progress nor blocks the next search until it times out.
 */
export async function findSearchInFlight(deps: {
  db: D1Database;
  apify: ApifyClient | null;
  now?: () => Date;
}): Promise<SearchRunWithIngest | null> {
  const searches = new SearchRunsRepository(deps.db);
  const search = await searches.findInFlight(inFlightCutoffs(deps.now?.() ?? new Date()));
  if (!search?.apify_run_id || search.status !== 'started' || search.ingest_status || !deps.apify) return search;
  try {
    const run = await deps.apify.getRun(search.apify_run_id, STATUS_CHECK_TIMEOUT_MS);
    if (UNSUCCESSFUL_RUN_STATUSES.has(run.status)) {
      await searches.markFailed(search.id, `Apify run ${run.status.toLowerCase()}`);
      return null;
    }
  } catch {
    // Apify or D1 unavailable: keep showing the search as in progress.
  }
  return search;
}

/** What a search is doing now, from its own row and its ingestion's status. */
export type SearchProgress = 'starting' | 'running' | 'processing' | 'succeeded' | 'failed' | 'unknown';

export function searchProgress(search: SearchRun, ingestStatus: string | null, now: Date): SearchProgress {
  if (ingestStatus === 'processing' || ingestStatus === 'succeeded' || ingestStatus === 'failed') return ingestStatus;
  if (search.status === 'failed') return 'failed';
  const age = now.getTime() - Date.parse(search.started_at);
  if (search.status === 'starting') return age < STARTING_TIMEOUT_MS ? 'starting' : 'unknown';
  return age < SEARCH_TIMEOUT_MS ? 'running' : 'unknown';
}
