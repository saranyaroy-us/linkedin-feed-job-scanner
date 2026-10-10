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
  /** Valid posts of a date-range search that were posted outside the range (not stored). */
  out_of_range: number;
  /** Items dropped before normalization because their text lacks "hiring" (never stored). */
  dropped_no_hiring: number;
  /** Items dropped because the job is outside the US (never stored). */
  dropped_non_us: number;
  /** Items dropped because the job's location is missing or ambiguous (never stored). */
  dropped_location_unknown: number;
  status: IngestRunStatus | null;
  /** Non-sensitive failure reason when status = 'failed'. */
  error: string | null;
  /** Dataset pages in the run; 0 until the last (short or empty) page has been read. */
  pages_total: number;
  /** Items per dataset page, fixed when the run is first recorded. */
  page_size: number;
  /** 1 when the run's items went through the hard filters; null for historical runs ingested before them. */
  screened: 1 | null;
  created_at: string;
}

/** A run ingested before the hiring and US-job hard filters existed. */
export const isHistoricalRun = (run: Pick<IngestRun, 'screened'>) => run.screened !== 1;
