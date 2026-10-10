import * as z from 'zod';

/** Time windows a manual search can cover. */
export const SearchWindowSchema = z.enum(['24h', 'week', 'month', 'range']);
export type SearchWindow = z.infer<typeof SearchWindowSchema>;

export type SearchRunStatus = 'starting' | 'started' | 'failed';

/** A row of `search_runs`: one per "Run Search" request from the dashboard. */
export interface SearchRun {
  id: number;
  search_window: SearchWindow;
  /** Start of the requested window (UTC ISO). */
  requested_from: string;
  /** End of the requested window, exclusive (UTC ISO). */
  requested_to: string;
  /** Set once Apify accepted the run; its ingestion is the ingest_runs row with this id. */
  apify_run_id: string | null;
  status: SearchRunStatus;
  /** Non-sensitive reason when status = 'failed'. */
  error: string | null;
  started_at: string;
}
