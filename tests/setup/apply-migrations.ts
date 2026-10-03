import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Storage is isolated per test file; this applies the real migrations to each file's D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
