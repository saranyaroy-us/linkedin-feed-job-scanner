import { RAW_JSON_RETENTION_DAYS } from '../config/retention';
import { PostsRepository } from '../storage/posts.repository';

/**
 * Posts cleared per cron run. Hourly runs can clear 48k posts a day — far more
 * than are stored daily — while each run stays one short, bounded D1 statement.
 */
export const RETENTION_BATCH_SIZE = 2_000;

const DAY_MS = 24 * 60 * 60_000;

export interface RetentionResult {
  /** Posts stored before this time had raw_json cleared. */
  cutoff: string;
  cleared: number;
  rowsRead: number;
}

/**
 * Hourly cron: sets raw_json = NULL on posts stored more than
 * RAW_JSON_RETENTION_DAYS ago. Rows and normalized columns are kept. Cleared
 * posts no longer match, so repeated or overlapping runs are harmless, and a
 * backlog (e.g. after the cron was paused) drains over the following runs.
 */
export async function clearExpiredRawJson(
  db: D1Database,
  now: Date,
  batchSize = RETENTION_BATCH_SIZE,
): Promise<RetentionResult> {
  const cutoff = new Date(now.getTime() - RAW_JSON_RETENTION_DAYS * DAY_MS).toISOString();
  const { cleared, rowsRead } = await new PostsRepository(db).clearRawJsonStoredBefore(cutoff, batchSize);
  console.log(`retention: cleared raw_json on ${cleared} post(s) stored before ${cutoff} (rows read ${rowsRead})`);
  return { cutoff, cleared, rowsRead };
}
