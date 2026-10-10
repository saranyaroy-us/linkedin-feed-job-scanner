import type { IngestRunStatus } from '../domain/ingest-run';
import type { SearchRun, SearchWindow } from '../domain/search-run';

/** Instants (UTC ISO) that decide whether an earlier search is still in flight. */
export interface InFlightCutoffs {
  /** A 'starting' search older than this is presumed dead (its request stopped before Apify answered). */
  startingAfter: string;
  /** A 'started' search older than this no longer counts as in flight, finished or not. */
  startedAfter: string;
}

export interface StartInput extends InFlightCutoffs {
  window: SearchWindow;
  requestedFrom: string;
  requestedTo: string;
  now: string;
}

/** A search plus the status of its ingestion (null until Apify's webhook has arrived). */
export interface SearchRunWithIngest extends SearchRun {
  ingest_status: IngestRunStatus | null;
}

/** Maximum stored length of a failure reason. */
const MAX_ERROR_LENGTH = 300;

/**
 * A search still in flight (?1 = startingAfter, ?2 = startedAfter): 'starting'
 * (Apify has not answered yet), or 'started' and its ingestion has not finished.
 * Both expire, so a run that never reports back (e.g. an Apify run that failed,
 * whose SUCCEEDED webhook never comes) cannot block new searches for long.
 */
const IN_FLIGHT_SQL = `s.started_at > ?2 AND (
    (s.status = 'starting' AND s.started_at > ?1)
    OR (s.status = 'started' AND NOT EXISTS (
      SELECT 1 FROM ingest_runs i WHERE i.apify_run_id = s.apify_run_id AND i.status IN ('succeeded', 'failed'))))`;

export class SearchRunsRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Records a new search as 'starting' unless another one is in flight, in one
   * statement, so two simultaneous submissions cannot both get a row. Returns
   * the new row, or null when another search is in flight.
   */
  async tryStart(input: StartInput): Promise<SearchRun | null> {
    return this.db
      .prepare(
        `INSERT INTO search_runs (search_window, requested_from, requested_to, status, started_at)
         SELECT ?3, ?4, ?5, 'starting', ?6
         WHERE NOT EXISTS (SELECT 1 FROM search_runs s WHERE ${IN_FLIGHT_SQL})
         RETURNING *`,
      )
      .bind(input.startingAfter, input.startedAfter, input.window, input.requestedFrom, input.requestedTo, input.now)
      .first<SearchRun>();
  }

  /** Apify accepted the run: link it, so its ingestion can be found. */
  async markStarted(id: number, apifyRunId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE search_runs SET status = 'started', apify_run_id = ?2 WHERE id = ?1`)
      .bind(id, apifyRunId)
      .run();
  }

  async markFailed(id: number, error: string): Promise<void> {
    await this.db
      .prepare(`UPDATE search_runs SET status = 'failed', error = ?2 WHERE id = ?1`)
      .bind(id, error.slice(0, MAX_ERROR_LENGTH))
      .run();
  }

  /** The newest search still in flight, if any. */
  async findInFlight(cutoffs: InFlightCutoffs): Promise<SearchRunWithIngest | null> {
    return this.db
      .prepare(
        `SELECT s.*, (SELECT i.status FROM ingest_runs i WHERE i.apify_run_id = s.apify_run_id) AS ingest_status
         FROM search_runs s
         WHERE ${IN_FLIGHT_SQL}
         ORDER BY s.started_at DESC, s.id DESC
         LIMIT 1`,
      )
      .bind(cutoffs.startingAfter, cutoffs.startedAfter)
      .first<SearchRunWithIngest>();
  }

  /**
   * The posted-at range [from, to) a date-range search keeps, for the run it
   * started; null for runs of other windows (nothing is filtered).
   */
  async postedRange(apifyRunId: string): Promise<{ from: string; to: string } | null> {
    return this.db
      .prepare(
        `SELECT requested_from AS "from", requested_to AS "to" FROM search_runs
         WHERE apify_run_id = ? AND search_window = 'range'`,
      )
      .bind(apifyRunId)
      .first<{ from: string; to: string }>();
  }

  async list(limit = 100): Promise<SearchRun[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM search_runs ORDER BY started_at DESC, id DESC LIMIT ?')
      .bind(limit)
      .all<SearchRun>();
    return results;
  }
}
