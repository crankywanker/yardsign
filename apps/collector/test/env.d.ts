import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env as CollectorEnv } from '../src/env';

// `env` from "cloudflare:test" is typed as Cloudflare.Env in this pool version.
declare global {
  namespace Cloudflare {
    interface Env extends CollectorEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
