/** Access tokens for sync jobs: decrypt, refresh when close to expiry, re-encrypt for storage. */
import {
  type Connection,
  decryptCredentials,
  encryptCredentials,
  type OAuthCredentials,
} from "../shared/connections";
import { type Fetcher, ProviderError } from "../shared/http";
import { PROVIDERS, refreshIfNeeded } from "./oauth";

export interface FreshToken {
  token: string;
  /** Set when the token was refreshed: persist it with the sync result. */
  credentialsEnc?: string;
}

export async function freshToken(
  env: Cloudflare.Env,
  fetcher: Fetcher,
  conn: Pick<Connection, "kind" | "siteId" | "credentialsEnc">,
  now: number,
): Promise<FreshToken> {
  const creds = await decryptCredentials<OAuthCredentials>(env, conn).catch(() => null);
  if (!creds?.accessToken) {
    throw new ProviderError(
      PROVIDERS[conn.kind].label,
      401,
      `${PROVIDERS[conn.kind].label}: not connected`,
    );
  }
  const refreshed = await refreshIfNeeded(fetcher, env, conn.kind, creds, now);
  if (!refreshed) return { token: creds.accessToken };
  return {
    token: refreshed.accessToken,
    credentialsEnc: await encryptCredentials(env, conn.kind, conn.siteId, refreshed),
  };
}
