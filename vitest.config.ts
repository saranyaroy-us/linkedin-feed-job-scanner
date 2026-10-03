import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Keep a developer's local .env (real secrets for `wrangler dev`) out of tests.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';

/**
 * Tests run inside workerd with a real (local, in-memory) D1 that has the
 * migrations in ./migrations applied. Secrets are fixed test values, and
 * outbound network is blocked so no test can ever reach the real Apify API.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          APIFY_TOKEN: 'test-apify-token',
          APIFY_WEBHOOK_SECRET: 'test-webhook-secret',
          DASHBOARD_USERNAME: 'admin',
          DASHBOARD_PASSWORD: 'test-dashboard-password',
          APIFY_TASK_ID: '',
          DISPLAY_TIMEZONE: 'Asia/Kolkata',
        },
        // Any real outbound fetch gets this response instead of reaching the network.
        outboundService: () =>
          new Response('Outbound network is blocked in tests', { status: 418, headers: { 'x-test-blocked': '1' } }),
      },
    })),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup/apply-migrations.ts'],
  },
});
