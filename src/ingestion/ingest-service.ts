import { ApifyApiError, type ApifyClient } from '../apify/client';
import type { IngestPageMessage } from '../apify/types';
import { ACTOR_ID } from '../config/search-config';
import type { IngestRun } from '../domain/ingest-run';
import { normalizePosts } from '../normalization/post-normalizer';
import { IngestRunsRepository } from '../storage/ingest-runs.repository';
import { PostsRepository } from '../storage/posts.repository';

/**
 * Items per queue message. Each page is ingested in its own Worker invocation,
 * which keeps every invocation inside the Workers Free 10 ms CPU limit
 * (50-item pages measured 10–13 ms in production, 23 ms on a cold start).
 */
export const PAGE_SIZE = 25;

/** A 'processing' run older than this may be restarted by a redelivered webhook. */
export const STALE_RUN_MS = 30 * 60_000;

/**
 * Delivery attempts per page before its run is marked failed. The queue's
 * max_retries is higher, so a page whose invocation keeps dying (CPU limit, D1
 * outage) still gets later deliveries that mark the run failed cheaply.
 */
export const MAX_PAGE_ATTEMPTS = 5;

export interface IngestDeps {
  db: D1Database;
  apify: ApifyClient;
  queue: Queue<IngestPageMessage>;
  now?: () => Date;
  /** When set, only runs started from this Apify Task are accepted. */
  expectedTaskId?: string;
  pageSize?: number;
}

export type StartRunOutcome =
  | { kind: 'duplicate'; run: IngestRun }
  | { kind: 'in_progress'; run: IngestRun }
  | { kind: 'rejected'; reason: string }
  | { kind: 'queued'; run: IngestRun };

const nowIso = (deps: { now?: () => Date }) => (deps.now?.() ?? new Date()).toISOString();

/**
 * Called by the webhook for a SUCCEEDED Apify run. Verifies the run against
 * the Apify API (the webhook body is not trusted), records it in ingest_runs,
 * and queues the first dataset page; each full page queues the next one.
 * Idempotent: a run that already succeeded or is in progress is not queued again.
 */
export async function startIngestRun(apifyRunId: string, deps: IngestDeps): Promise<StartRunOutcome> {
  const runs = new IngestRunsRepository(deps.db);

  const existing = await runs.findByApifyRunId(apifyRunId);
  if (existing?.status === 'succeeded') return { kind: 'duplicate', run: existing };

  const [run, userId] = await Promise.all([deps.apify.getRun(apifyRunId), deps.apify.getCurrentUserId()]);
  if (run.userId !== userId) return { kind: 'rejected', reason: 'run does not belong to this Apify account' };
  if (run.actId !== ACTOR_ID) return { kind: 'rejected', reason: 'run is not from the expected Actor' };
  if (deps.expectedTaskId && run.actorTaskId !== deps.expectedTaskId) {
    return { kind: 'rejected', reason: 'run is not from the expected Apify Task' };
  }
  if (run.status !== 'SUCCEEDED') return { kind: 'rejected', reason: `run status is ${run.status}` };

  const input = run.defaultKeyValueStoreId ? await deps.apify.getRunInput(run.defaultKeyValueStoreId) : null;
  const now = deps.now?.() ?? new Date();
  const claimed = await runs.claim({
    apifyRunId,
    datasetId: run.defaultDatasetId,
    queryConfigJson: input === null ? null : JSON.stringify(input),
    pageSize: deps.pageSize ?? PAGE_SIZE,
    now: now.toISOString(),
    staleBefore: new Date(now.getTime() - STALE_RUN_MS).toISOString(),
  });

  if (!claimed) {
    const current = await runs.findByApifyRunId(apifyRunId);
    if (current?.status === 'succeeded') return { kind: 'duplicate', run: current };
    return { kind: 'in_progress', run: current! };
  }

  // The dataset's itemCount can lag right after a run finishes, so the run is
  // never sized up front: pages are followed until a short (or empty) one.
  // A restarted run keeps its original page size (claimed.page_size), so the
  // pages it already recorded line up with the new messages.
  try {
    await deps.queue.send({ apifyRunId, datasetId: run.defaultDatasetId, offset: 0, limit: claimed.page_size });
  } catch (error) {
    await runs.markFailed(claimed.id, 'could not queue the first dataset page', nowIso(deps));
    throw error;
  }
  return { kind: 'queued', run: claimed };
}

export type PageOutcome = 'ingested' | 'skipped' | 'retry' | 'failed';

export interface PageResult {
  outcome: PageOutcome;
  /** The run, when this page completed it. */
  finished?: IngestRun | null;
}

/**
 * Queue consumer for one dataset page: fetch → normalize → insert (deduped) and
 * record the page — plus the run's page count if this is the last page — in one
 * D1 transaction; queue the next page if this one was full; complete the run
 * once every page is recorded. Safe to run more than once for the same message.
 * Never throws: every failure becomes 'retry' or 'failed'.
 */
export async function ingestPage(message: IngestPageMessage, attempts: number, deps: IngestDeps): Promise<PageResult> {
  const runs = new IngestRunsRepository(deps.db);
  let run: IngestRun | null = null;
  try {
    run = await runs.findByApifyRunId(message.apifyRunId);
    // Unknown run, or one that already finished or failed: nothing to do.
    if (!run || run.status !== 'processing') return { outcome: 'skipped' };

    if (attempts > MAX_PAGE_ATTEMPTS) {
      await runs.markFailed(run.id, `page at offset ${message.offset} kept failing`, nowIso(deps));
      return { outcome: 'failed' };
    }

    const pageNumber = Math.floor(message.offset / message.limit);
    let fetched: number;
    const recorded = await runs.findPage(run.id, message.offset);
    if (recorded) {
      fetched = recorded.fetched;
      // Redelivery after the page was stored: re-assert the page count in case
      // that part was lost, then carry on with chaining and completion.
      if (fetched < message.limit) await deps.db.batch([runs.setPagesTotalStatement(run.id, pageNumber + 1)]);
    } else {
      const items = await deps.apify.getDatasetItems(message.datasetId, message.offset, message.limit);
      const { posts, invalid } = await normalizePosts(items, { fetchedAt: nowIso(deps), apifyRunId: run.apify_run_id });
      fetched = items.length;
      await deps.db.batch([
        ...new PostsRepository(deps.db).insertStatements(posts),
        runs.recordPageStatement({ ingestRunId: run.id, offset: message.offset, fetched, invalid: invalid.length }),
        ...(fetched < message.limit ? [runs.setPagesTotalStatement(run.id, pageNumber + 1)] : []),
      ]);
    }

    // A full page means there may be more: queue the next one (a duplicate is harmless).
    if (fetched >= message.limit) await deps.queue.send({ ...message, offset: message.offset + message.limit });

    const finished = await runs.finalizeIfComplete(run.id, nowIso(deps));
    return { outcome: 'ingested', finished };
  } catch (error) {
    const retryable = !(error instanceof ApifyApiError) || error.retryable;
    if (retryable && attempts < MAX_PAGE_ATTEMPTS) return { outcome: 'retry' };
    if (!run) return { outcome: 'retry' }; // could not even read the run: let the queue retry
    try {
      await runs.markFailed(run.id, failureReason(error, message.offset), nowIso(deps));
    } catch {
      return { outcome: 'retry' }; // D1 unavailable; the attempts guard marks it failed later
    }
    return { outcome: 'failed' };
  }
}

/** A short, non-sensitive description of why a page failed. */
function failureReason(error: unknown, offset: number): string {
  const detail = error instanceof ApifyApiError ? error.message : 'storage or processing error';
  return `page at offset ${offset} failed: ${detail}`;
}
