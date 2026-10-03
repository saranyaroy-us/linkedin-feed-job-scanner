import type { Context } from 'hono';
import type { AppEnv } from '../config/env';

/** GET /health — public liveness + D1 reachability. Exposes no data or configuration. */
export async function healthHandler(c: Context<AppEnv>) {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ status: 'ok' });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
}
