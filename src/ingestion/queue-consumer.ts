import { createApifyClient, type FetchLike } from '../apify/client';
import { IngestPageMessageSchema } from '../apify/types';
import type { Env } from '../config/env';
import { ingestPage } from './ingest-service';

/** Retry delay for a failed page: 30 s, 60 s, 120 s … capped at 10 minutes. */
export const retryDelaySeconds = (attempts: number) => Math.min(30 * 2 ** Math.max(attempts - 1, 0), 600);

/**
 * Queue handler for INGEST_QUEUE. wrangler.jsonc sets max_batch_size = 1, so
 * each invocation (and its 10 ms CPU budget) handles a single dataset page.
 */
export async function handleIngestQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  options: { fetch?: FetchLike; now?: () => Date } = {},
): Promise<void> {
  if (!env.APIFY_TOKEN) {
    console.error('queue: APIFY_TOKEN is not configured; retrying later');
    batch.retryAll({ delaySeconds: 300 });
    return;
  }
  const apify = createApifyClient(env.APIFY_TOKEN, options.fetch);

  for (const message of batch.messages) {
    const parsed = IngestPageMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error('queue: dropping malformed ingest message');
      message.ack();
      continue;
    }
    const page = parsed.data;
    let result: Awaited<ReturnType<typeof ingestPage>>;
    try {
      result = await ingestPage(page, message.attempts, {
        db: env.DB,
        apify,
        queue: env.INGEST_QUEUE,
        now: options.now,
      });
    } catch {
      // ingestPage handles its own errors; this is a last-resort guard so the
      // message is retried with backoff instead of an immediate redelivery.
      result = { outcome: 'retry' };
    }

    if (result.outcome === 'retry') {
      console.warn(`queue: run ${page.apifyRunId} offset ${page.offset} failed (attempt ${message.attempts}); retrying`);
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    if (result.outcome === 'failed') {
      console.error(`queue: run ${page.apifyRunId} offset ${page.offset} failed permanently; run marked failed`);
    }
    if (result.finished) {
      const run = result.finished;
      console.log(
        `queue: run ${page.apifyRunId} complete — fetched ${run.fetched}, new ${run.new}, ` +
          `already seen ${run.already_seen}, invalid ${run.invalid}, out of range ${run.out_of_range}, ` +
          `no hiring ${run.dropped_no_hiring}, non-US ${run.dropped_non_us}, location unknown ${run.dropped_location_unknown}`,
      );
    }
    message.ack();
  }
}
