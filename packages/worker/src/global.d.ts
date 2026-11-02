import type { Env as DatagoatEnv } from './env';

// `cloudflare:workers` and `cloudflare:test` both expose `env` typed as
// `Cloudflare.Env`. Extending that interface here gives every test file the
// worker's real bindings (`DB`, `KV`, `INSTALL_SECRET`, `SECRET_VERSION`).
declare global {
  namespace Cloudflare {
    interface Env extends DatagoatEnv {}
  }
}
