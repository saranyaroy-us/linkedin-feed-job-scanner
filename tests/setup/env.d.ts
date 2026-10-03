import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../../src/config/env';

// Types `env` from 'cloudflare:workers' in tests: the Worker's bindings plus test-only ones.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
