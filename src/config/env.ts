import type { IngestPageMessage } from '../apify/types';

/**
 * Worker bindings (see wrangler.jsonc). Secrets are optional in the type so
 * every route checks for them and fails closed when one is missing.
 */
export interface Env {
  /** D1 database. */
  DB: D1Database;
  /** Queue of dataset pages to ingest (producer + consumer in this Worker). */
  INGEST_QUEUE: Queue<IngestPageMessage>;

  /** Secret: Apify API token, used to read runs and datasets. */
  APIFY_TOKEN?: string;
  /** Secret: shared secret Apify sends in the X-Apify-Webhook-Secret header. */
  APIFY_WEBHOOK_SECRET?: string;
  /** Secrets: HTTP Basic credentials for the dashboard and /api. */
  DASHBOARD_USERNAME?: string;
  DASHBOARD_PASSWORD?: string;

  /** Var: IANA zone for displaying times and "today" (default Asia/Kolkata). */
  DISPLAY_TIMEZONE?: string;
  /** Var: optional Apify Task id; when set, only runs of that task are ingested. */
  APIFY_TASK_ID?: string;
}

export type AppEnv = { Bindings: Env };

/** Header Apify must send (configured in the webhook's headers template). */
export const WEBHOOK_SECRET_HEADER = 'X-Apify-Webhook-Secret';
