import * as z from 'zod';

export const IngestRunStatusSchema = z.enum(['processing', 'succeeded', 'failed']);
export type IngestRunStatus = z.infer<typeof IngestRunStatusSchema>;

/** A row of `ingest_runs`: one per Apify run delivered by webhook. */
export interface IngestRun {
  id: number;
  started_at: string;
  completed_at: string | null;
  apify_run_id: string | null;
  dataset_id: string | null;
  /** The input the Apify run actually used (from its INPUT record), as JSON. */
  query_config_json: string | null;
  fetched: number;
  new: number;
  already_seen: number;
  invalid: number;
  status: IngestRunStatus | null;
  /** Non-sensitive failure reason when status = 'failed'. */
  error: string | null;
  /** Dataset pages in the run; 0 until the last (short or empty) page has been read. */
  pages_total: number;
  /** Items per dataset page, fixed when the run is first recorded. */
  page_size: number;
  created_at: string;
}
