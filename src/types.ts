/** Hono environment types shared by every router. */
import type { Role } from "../shared/permissions";
import type { AuthContext } from "./auth/context";
import type { Site } from "./lib/sites";

export type Bindings = Cloudflare.Env;

export interface AppVariables {
  /** Set by `authenticate` when the request carries a valid session cookie or Bearer credential. */
  auth: AuthContext | undefined;
  /** Set by `requireSite*` middleware: the website the request targets. */
  site: Site;
  /** Set by `requireSite*` middleware: the caller's effective role on `site`. */
  role: Role;
  requestId: string;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: AppVariables;
}
