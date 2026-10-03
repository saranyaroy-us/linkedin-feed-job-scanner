import type { Context } from 'hono';
import { ApifyApiError, createApifyClient, type FetchLike } from '../apify/client';
import { ApifyIdSchema, ApifyWebhookPayloadSchema, SUCCEEDED_EVENT } from '../apify/types';
import { WEBHOOK_SECRET_HEADER, type AppEnv } from '../config/env';
import { startIngestRun } from '../ingestion/ingest-service';
import { safeEqual } from '../lib/safe-equal';

/** Apify's run payload is a few KB; anything far larger is not a real webhook. */
export const WEBHOOK_MAX_BYTES = 64 * 1024;

export interface WebhookOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: FetchLike;
  now?: () => Date;
}

/**
 * POST /webhooks/apify. Response codes follow Apify's retry rule (any non-2xx
 * is retried, up to 11 times over ~32 h):
 *   200 — queued (first dataset page sent), duplicate (run already succeeded), or
 *         ignored (non-SUCCEEDED events incl. TEST; runs of another account,
 *         Actor or Task; runs whose real status is not SUCCEEDED)
 *   401 — missing/wrong shared secret
 *   409 — run already being processed (Apify retries later; a stale claim is taken over)
 *   422 — body is not a usable Apify webhook / unknown run
 *   502/503 — transient Apify, Queue or D1 failure, or the Worker is not configured
 * Responses and logs carry only run ids and counts — never secrets or post content.
 */
export function apifyWebhookHandler(options: WebhookOptions = {}) {
  return async (c: Context<AppEnv>) => {
    const { APIFY_WEBHOOK_SECRET, APIFY_TOKEN } = c.env;
    if (!APIFY_WEBHOOK_SECRET || !APIFY_TOKEN) {
      console.error('webhook: APIFY_WEBHOOK_SECRET or APIFY_TOKEN is not configured');
      return c.json({ error: 'not configured' }, 503);
    }

    if (!(await safeEqual(c.req.header(WEBHOOK_SECRET_HEADER) ?? '', APIFY_WEBHOOK_SECRET))) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid JSON' }, 422);
    }
    const payload = ApifyWebhookPayloadSchema.safeParse(body);
    if (!payload.success) return c.json({ error: 'not an Apify webhook payload' }, 422);

    // Console "Test" deliveries (eventType TEST) and other events are acknowledged, not retried.
    if (payload.data.eventType !== SUCCEEDED_EVENT) {
      return c.json({ status: 'ignored', eventType: payload.data.eventType }, 200);
    }

    const runId = ApifyIdSchema.safeParse(payload.data.eventData?.actorRunId ?? payload.data.resource?.id);
    if (!runId.success) return c.json({ error: 'missing or malformed run id' }, 422);

    try {
      const outcome = await startIngestRun(runId.data, {
        db: c.env.DB,
        queue: c.env.INGEST_QUEUE,
        apify: createApifyClient(APIFY_TOKEN, options.fetch),
        expectedTaskId: c.env.APIFY_TASK_ID || undefined,
        now: options.now,
      });

      switch (outcome.kind) {
        case 'queued':
          console.log(`webhook: run ${runId.data} queued for ingestion`);
          return c.json({ status: 'queued', apifyRunId: runId.data }, 200);
        case 'duplicate':
          return c.json({ status: 'duplicate', apifyRunId: runId.data }, 200);
        case 'in_progress':
          return c.json({ status: 'in_progress', apifyRunId: runId.data }, 409);
        case 'rejected':
          console.warn(`webhook: run ${runId.data} rejected: ${outcome.reason}`);
          return c.json({ status: 'ignored', reason: outcome.reason }, 200);
      }
    } catch (error) {
      if (error instanceof ApifyApiError) {
        console.error(`webhook: run ${runId.data}: ${error.message}`);
        return error.status === 404
          ? c.json({ error: 'unknown Apify run' }, 422)
          : c.json({ error: 'Apify API unavailable' }, 502);
      }
      console.error(`webhook: run ${runId.data}: ${error instanceof Error ? error.name : 'error'} while starting ingestion`);
      return c.json({ error: 'temporarily unavailable' }, 503);
    }
  };
}
