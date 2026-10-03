import type { Context } from 'hono';
import type { AppEnv } from '../config/env';
import { resolveTimeZone } from '../lib/time';
import { IngestRunsRepository } from '../storage/ingest-runs.repository';
import { runsPage } from '../views/runs';

const RUNS_SHOWN = 60;

/** GET /runs — ingestion history, newest first. */
export async function runsHandler(c: Context<AppEnv>) {
  const runs = await new IngestRunsRepository(c.env.DB).list(RUNS_SHOWN);
  return c.html(runsPage(runs, resolveTimeZone(c.env.DISPLAY_TIMEZONE)));
}
