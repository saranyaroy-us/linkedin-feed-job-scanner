import { Hono, type MiddlewareHandler } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { FetchLike } from './apify/client';
import type { IngestPageMessage } from './apify/types';
import type { AppEnv, Env } from './config/env';
import { handleIngestQueue } from './ingestion/queue-consumer';
import { clearExpiredRawJson } from './maintenance/raw-json-retention';
import { apiPostsHandler } from './routes/api-posts';
import { dashboardHandler } from './routes/dashboard';
import { healthHandler } from './routes/health';
import { runsHandler } from './routes/runs';
import { apifyWebhookHandler, WEBHOOK_MAX_BYTES } from './webhook/apify-webhook';

export interface AppOptions {
  /** Outbound fetch for Apify API calls (injected in tests). */
  fetch?: FetchLike;
  now?: () => Date;
}

/**
 * HTTP Basic auth for the dashboard and API, built per request from secrets.
 * Fails closed (503) when the credentials are not configured. Responses are
 * marked uncacheable since they contain LinkedIn post data.
 */
const requireDashboardAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { DASHBOARD_USERNAME: username, DASHBOARD_PASSWORD: password } = c.env;
  if (!username || !password) {
    return c.text('Dashboard credentials are not configured.', 503);
  }
  await basicAuth({ username, password, realm: 'LinkedIn Job Signals' })(c, next);
  c.header('Cache-Control', 'private, no-store');
};

export function createApp(options: AppOptions = {}) {
  const app = new Hono<AppEnv>();

  app.use(
    '*',
    secureHeaders({
      // Server-rendered HTML with one inline <style> and no scripts.
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        imgSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  app.get('/health', healthHandler);

  app.post(
    '/webhooks/apify',
    bodyLimit({ maxSize: WEBHOOK_MAX_BYTES, onError: (c) => c.json({ error: 'payload too large' }, 413) }),
    apifyWebhookHandler(options),
  );

  app.get('/', requireDashboardAuth, dashboardHandler(options));
  app.get('/runs', requireDashboardAuth, runsHandler);
  app.get('/api/posts', requireDashboardAuth, apiPostsHandler(options));

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((error, c) => {
    // HTTPException (e.g. 401 from basic auth) carries its own response.
    if ('getResponse' in error && typeof error.getResponse === 'function') return error.getResponse();
    console.error(`unhandled ${error.name} on ${c.req.method} ${c.req.path}`);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  queue: (batch, env) => handleIngestQueue(batch, env),
  // The hourly cron in wrangler.jsonc: raw_json retention.
  scheduled: async (controller, env) => {
    await clearExpiredRawJson(env.DB, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env, IngestPageMessage>;
