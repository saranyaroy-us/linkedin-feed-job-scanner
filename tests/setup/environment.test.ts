import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('uses fixed test secrets, never a developer .env', () => {
    expect(env.APIFY_TOKEN).toBe('test-apify-token');
    expect(env.APIFY_WEBHOOK_SECRET).toBe('test-webhook-secret');
  });

  it('blocks outbound network so tests cannot reach the real Apify API', async () => {
    const response = await fetch('https://api.apify.com/v2/users/me');
    expect(response.status).toBe(418);
    expect(response.headers.get('x-test-blocked')).toBe('1');
  });

  it('has the D1 migrations applied', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'd1_migrations',
        'ingest_run_pages',
        'ingest_runs',
        'post_query_counts',
        'raw_posts',
        'trg_raw_posts_count_delete',
        'trg_raw_posts_count_insert',
        'idx_raw_posts_raw_json_pending', // 0002
      ]),
    );
  });
});
