import type { IngestRun } from '../domain/ingest-run';

export interface ClaimInput {
  apifyRunId: string;
  datasetId: string;
  queryConfigJson: string | null;
  /** Items per page; only used when the run is first recorded. */
  pageSize: number;
  now: string;
  /** A 'processing' run whose started_at is older than this may be taken over. */
  staleBefore: string;
}

export interface PageRecord {
  ingestRunId: number;
  offset: number;
  fetched: number;
  invalid: number;
}

/** Maximum stored length of a failure reason. */
const MAX_ERROR_LENGTH = 300;

const PAGES_SQL = 'FROM ingest_run_pages p WHERE p.ingest_run_id = ingest_runs.id';
const FETCHED_SQL = `(SELECT COALESCE(SUM(p.fetched), 0) ${PAGES_SQL})`;
const INVALID_SQL = `(SELECT COALESCE(SUM(p.invalid), 0) ${PAGES_SQL})`;
const INSERTED_SQL = '(SELECT COUNT(*) FROM raw_posts r WHERE r.apify_run_id = ingest_runs.apify_run_id)';
/** Run totals from the recorded pages (index-backed subqueries). */
const TOTALS_SQL = `fetched = ${FETCHED_SQL}, invalid = ${INVALID_SQL}, new = ${INSERTED_SQL},
  already_seen = MAX(${FETCHED_SQL} - ${INVALID_SQL} - ${INSERTED_SQL}, 0)`;

export class IngestRunsRepository {
  constructor(private readonly db: D1Database) {}

  async findByApifyRunId(apifyRunId: string): Promise<IngestRun | null> {
    return this.db.prepare('SELECT * FROM ingest_runs WHERE apify_run_id = ?').bind(apifyRunId).first<IngestRun>();
  }

  async findById(id: number): Promise<IngestRun | null> {
    return this.db.prepare('SELECT * FROM ingest_runs WHERE id = ?').bind(id).first<IngestRun>();
  }

  /**
   * Atomically starts (or restarts) ingestion of an Apify run. Returns the run
   * row if this caller now owns it, or null if the run already succeeded or is
   * being processed by someone else. A 'failed' run, or a 'processing' run that
   * went stale, is reset and handed to the caller. Already-recorded pages,
   * pages_total, page_size and the partial totals are kept: the dataset of a
   * finished run never changes, and totals are recomputed when it completes.
   */
  async claim(input: ClaimInput): Promise<IngestRun | null> {
    return this.db
      .prepare(
        `INSERT INTO ingest_runs (started_at, apify_run_id, dataset_id, query_config_json, page_size, status)
         VALUES (?1, ?2, ?3, ?4, ?6, 'processing')
         ON CONFLICT (apify_run_id) DO UPDATE SET
           started_at = excluded.started_at,
           completed_at = NULL,
           dataset_id = excluded.dataset_id,
           query_config_json = excluded.query_config_json,
           status = 'processing',
           error = NULL
         WHERE ingest_runs.status = 'failed'
            OR (ingest_runs.status = 'processing' AND ingest_runs.started_at < ?5)
         RETURNING *`,
      )
      .bind(input.now, input.apifyRunId, input.datasetId, input.queryConfigJson, input.staleBefore, input.pageSize)
      .first<IngestRun>();
  }

  /** The recorded page at `offset`, or null if it has not been processed yet. */
  async findPage(ingestRunId: number, offset: number): Promise<{ fetched: number; invalid: number } | null> {
    return this.db
      .prepare('SELECT fetched, invalid FROM ingest_run_pages WHERE ingest_run_id = ? AND page_offset = ?')
      .bind(ingestRunId, offset)
      .first<{ fetched: number; invalid: number }>();
  }

  /** Statement recording a processed page; batch it with the page's post inserts. */
  recordPageStatement(page: PageRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO ingest_run_pages (ingest_run_id, page_offset, fetched, invalid)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (ingest_run_id, page_offset) DO NOTHING`,
      )
      .bind(page.ingestRunId, page.offset, page.fetched, page.invalid);
  }

  /**
   * Statement setting the run's page count once its last (short or empty) page
   * is known. Batch it with that page's record so both commit together.
   */
  setPagesTotalStatement(ingestRunId: number, pagesTotal: number): D1PreparedStatement {
    return this.db
      .prepare(`UPDATE ingest_runs SET pages_total = ?2 WHERE id = ?1 AND status = 'processing'`)
      .bind(ingestRunId, pagesTotal);
  }

  /**
   * Marks the run succeeded once its last page is known (pages_total > 0) and
   * every page up to it is recorded, filling in the totals. "new" is the number
   * of posts this run stored first, so it stays exact across retries and
   * redeliveries. Returns the finished run, or null if pages are still
   * outstanding (or another page already finished it).
   */
  async finalizeIfComplete(ingestRunId: number, now: string): Promise<IngestRun | null> {
    return this.db
      .prepare(
        `UPDATE ingest_runs SET status = 'succeeded', completed_at = ?2, ${TOTALS_SQL}
         WHERE id = ?1
           AND status = 'processing'
           AND pages_total > 0
           AND (SELECT COUNT(*) ${PAGES_SQL}) >= pages_total
         RETURNING *`,
      )
      .bind(ingestRunId, now)
      .first<IngestRun>();
  }

  /** Marks a processing run failed, keeping the partial totals of the pages that were stored. */
  async markFailed(ingestRunId: number, error: string, now: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE ingest_runs SET status = 'failed', error = ?2, completed_at = ?3, ${TOTALS_SQL}
         WHERE id = ?1 AND status = 'processing'`,
      )
      .bind(ingestRunId, error.slice(0, MAX_ERROR_LENGTH), now)
      .run();
  }

  async latest(): Promise<IngestRun | null> {
    return this.db.prepare('SELECT * FROM ingest_runs ORDER BY started_at DESC, id DESC LIMIT 1').first<IngestRun>();
  }

  async list(limit = 100): Promise<IngestRun[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM ingest_runs ORDER BY started_at DESC, id DESC LIMIT ?')
      .bind(limit)
      .all<IngestRun>();
    return results;
  }
}
