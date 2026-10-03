import * as z from 'zod';

/** Apify resource ids (runs, datasets, key-value stores) are short alphanumeric strings. */
export const ApifyIdSchema = z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'not an Apify id');

export const SUCCEEDED_EVENT = 'ACTOR.RUN.SUCCEEDED';

/**
 * Apify's default webhook payload:
 * { userId, createdAt, eventType, eventData: { actorId, actorTaskId?, actorRunId }, resource: <run object> }.
 * Only the fields we use are validated; everything else passes through. The body
 * is never trusted beyond the run id — the run itself is re-fetched from the API.
 */
export const ApifyWebhookPayloadSchema = z.looseObject({
  eventType: z.string(),
  eventData: z
    .looseObject({
      actorId: z.string().nullish(),
      actorTaskId: z.string().nullish(),
      actorRunId: z.string().nullish(),
    })
    .nullish(),
  resource: z.looseObject({ id: z.string().nullish() }).nullish(),
});

export type ApifyWebhookPayload = z.infer<typeof ApifyWebhookPayloadSchema>;

/**
 * Subset of GET /v2/actor-runs/{runId} → data. That endpoint is readable
 * without a token (the run id is the credential), so ownership is checked by
 * comparing userId with the token's own user.
 */
export const ApifyRunSchema = z.looseObject({
  id: ApifyIdSchema,
  userId: z.string(),
  actId: z.string(),
  actorTaskId: z.string().nullish(),
  status: z.string(),
  defaultDatasetId: ApifyIdSchema,
  defaultKeyValueStoreId: ApifyIdSchema.nullish(),
});

export type ApifyRun = z.infer<typeof ApifyRunSchema>;

/** Subset of GET /v2/users/me → data. */
export const ApifyUserSchema = z.looseObject({ id: z.string() });

/** One page of dataset items to ingest; the payload of an ingest-queue message. */
export const IngestPageMessageSchema = z.object({
  apifyRunId: ApifyIdSchema,
  datasetId: ApifyIdSchema,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

export type IngestPageMessage = z.infer<typeof IngestPageMessageSchema>;
