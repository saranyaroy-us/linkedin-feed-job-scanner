import * as z from 'zod';
import { ApifyIdSchema, ApifyRunSchema, ApifyUserSchema, type ApifyRun } from './types';

export const APIFY_API_BASE = 'https://api.apify.com/v2';

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Error from an Apify API call. The message names only the operation and HTTP
 * status — never the token, URL query or response body.
 */
export class ApifyApiError extends Error {
  override name = 'ApifyApiError';
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }

  /** 5xx, 429 and network errors are worth retrying; other 4xx are not. */
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApifyClient {
  /** Id of the user that owns the API token. */
  getCurrentUserId(): Promise<string>;
  getRun(runId: string): Promise<ApifyRun>;
  /** The INPUT record the run was started with, or null if absent/unreadable. */
  getRunInput(keyValueStoreId: string): Promise<unknown>;
  getDatasetItems(datasetId: string, offset: number, limit: number): Promise<unknown[]>;
}

const DataEnvelope = <T extends z.ZodType>(schema: T) => z.object({ data: schema });

export function createApifyClient(token: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): ApifyClient {
  async function request(operation: string, path: string, allowNotFound = false): Promise<Response | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${APIFY_API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApifyApiError(`Apify ${operation} failed (network error or timeout)`, null);
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new ApifyApiError(`Apify ${operation} failed (HTTP ${response.status})`, response.status);
    return response;
  }

  async function json<T extends z.ZodType>(operation: string, response: Response, schema: T): Promise<z.infer<T>> {
    let body: unknown;
    try {
      // A reset connection or timeout mid-body (or a truncated body) is transient:
      // status null marks it retryable. Only a well-formed but unexpected shape is permanent.
      body = JSON.parse(await response.text());
    } catch {
      throw new ApifyApiError(`Apify ${operation} response could not be read`, null);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApifyApiError(`Apify ${operation} returned an unexpected shape`, response.status);
    return parsed.data;
  }

  const id = (value: string) => encodeURIComponent(ApifyIdSchema.parse(value));

  return {
    async getCurrentUserId() {
      const response = await request('get current user', '/users/me');
      return (await json('get current user', response!, DataEnvelope(ApifyUserSchema))).data.id;
    },

    async getRun(runId) {
      const response = await request('get run', `/actor-runs/${id(runId)}`);
      return (await json('get run', response!, DataEnvelope(ApifyRunSchema))).data;
    },

    async getRunInput(keyValueStoreId) {
      try {
        const response = await request('get run input', `/key-value-stores/${id(keyValueStoreId)}/records/INPUT`, true);
        return response ? await response.json() : null;
      } catch {
        // The input is informational only; ingestion must not depend on it.
        return null;
      }
    },

    async getDatasetItems(datasetId, offset, limit) {
      const query = new URLSearchParams({ offset: String(offset), limit: String(limit), format: 'json' });
      const response = await request('get dataset items', `/datasets/${id(datasetId)}/items?${query}`);
      return json('get dataset items', response!, z.array(z.unknown()));
    },
  };
}
