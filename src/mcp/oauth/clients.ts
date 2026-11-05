/**
 * OAuth clients: dynamic registration (RFC 7591) and client ID metadata documents (an HTTPS URL
 * used as `client_id`, e.g. ChatGPT's and Codex's published documents), plus redirect URI rules.
 *
 * Redirect URIs: `https://…`, `http://` on a loopback host (any port at use time, RFC 8252 §7.3),
 * or a private-use scheme for native apps (`cursor://…`). They must match registration exactly,
 * except that a loopback redirect may use a different port.
 */
import { hashSecret } from "../../auth/credentials";
import { timingSafeEqual } from "../../lib/crypto";
import { parseJsonColumn } from "../../lib/d1";
import { randomBase62 } from "../../lib/ids";
import { log } from "../../lib/log";

export const CLIENT_TTL_MS = 365 * 86_400_000;
export const METADATA_CACHE_MS = 24 * 3_600_000;
const METADATA_MAX_BYTES = 16 * 1024;
const METADATA_TIMEOUT_MS = 5_000;

export type AuthMethod = "none" | "client_secret_basic" | "client_secret_post";
export const AUTH_METHODS: readonly AuthMethod[] = [
  "none",
  "client_secret_basic",
  "client_secret_post",
];

export interface OAuthClient {
  id: string;
  name: string | null;
  redirectUris: string[];
  authMethod: AuthMethod;
  secretHash: string | null;
  grantTypes: string[];
  /** Registered through a metadata document URL. */
  metadataUrl: string | null;
  clientUri: string | null;
  logoUri: string | null;
  createdAt: number;
  expiresAt: number | null;
}

interface ClientRow {
  id: string;
  secret_hash: string | null;
  name: string | null;
  redirect_uris: string;
  token_endpoint_auth_method: string;
  grant_types: string;
  metadata_url: string | null;
  metadata: string | null;
  created_at: number;
  expires_at: number | null;
}

export class ClientError extends Error {
  constructor(
    readonly code: "invalid_client_metadata" | "invalid_redirect_uri" | "invalid_client",
    message: string,
  ) {
    super(message);
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BLOCKED_SCHEMES = new Set([
  "javascript",
  "data",
  "file",
  "blob",
  "vbscript",
  "about",
  "ftp",
  "ws",
  "wss",
  "http",
  "https",
]);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** Validate a redirect URI for registration. Returns an error message or null. */
export function redirectUriProblem(value: string): string | null {
  if (value.length > 2000) return "redirect_uri is too long";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `redirect_uri is not a valid URL: ${value}`;
  }
  if (url.hash || value.includes("#")) return "redirect_uri must not contain a fragment";
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === "https") return url.hostname ? null : "redirect_uri needs a host";
  if (scheme === "http") {
    return isLoopbackHost(url.hostname)
      ? null
      : "http redirect URIs are only allowed on loopback hosts (127.0.0.1, localhost, [::1])";
  }
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || BLOCKED_SCHEMES.has(scheme)) {
    return `redirect_uri scheme "${scheme}" is not allowed`;
  }
  return null;
}

/** Whether a redirect URI presented at authorize/token time matches a registered one. */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let url: URL;
  try {
    url = new URL(presented);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (
        reg.protocol === url.protocol &&
        reg.hostname === url.hostname &&
        reg.pathname === url.pathname &&
        reg.search === url.search
      );
    } catch {
      return false;
    }
  });
}

function rowToClient(row: ClientRow): OAuthClient {
  const meta = parseJsonColumn<Record<string, unknown>>(row.metadata, {});
  return {
    id: row.id,
    name: row.name,
    redirectUris: parseJsonColumn<string[]>(row.redirect_uris, []),
    authMethod: (AUTH_METHODS as readonly string[]).includes(row.token_endpoint_auth_method)
      ? (row.token_endpoint_auth_method as AuthMethod)
      : "none",
    secretHash: row.secret_hash,
    grantTypes: parseJsonColumn<string[]>(row.grant_types, ["authorization_code"]),
    metadataUrl: row.metadata_url,
    clientUri: typeof meta.client_uri === "string" ? meta.client_uri : null,
    logoUri: typeof meta.logo_uri === "string" ? meta.logo_uri : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function optionalHttpsUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2000) {
    throw new ClientError("invalid_client_metadata", `${field} must be a URL`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("not https");
    return value;
  } catch {
    throw new ClientError("invalid_client_metadata", `${field} must be an https URL`);
  }
}

export interface ValidatedMetadata {
  name: string | null;
  redirectUris: string[];
  authMethod: AuthMethod;
  grantTypes: string[];
  stored: Record<string, unknown>;
}

/**
 * Validate RFC 7591 client metadata. Unknown fields are ignored; invalid supported fields are
 * rejected. `forDocument` applies the metadata-document rules (public clients only).
 */
export function validateClientMetadata(
  input: unknown,
  options: { forDocument?: boolean } = {},
): ValidatedMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ClientError("invalid_client_metadata", "Client metadata must be a JSON object");
  }
  const m = input as Record<string, unknown>;
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20) {
    throw new ClientError("invalid_redirect_uri", "redirect_uris must list 1–20 URIs");
  }
  for (const uri of uris) {
    if (typeof uri !== "string") {
      throw new ClientError("invalid_redirect_uri", "redirect_uris must be strings");
    }
    const problem = redirectUriProblem(uri);
    if (problem) throw new ClientError("invalid_redirect_uri", problem);
  }
  const defaultMethod: AuthMethod = options.forDocument ? "none" : "client_secret_basic";
  const method = m.token_endpoint_auth_method ?? defaultMethod;
  if (typeof method !== "string" || !(AUTH_METHODS as readonly string[]).includes(method)) {
    throw new ClientError(
      "invalid_client_metadata",
      `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`,
    );
  }
  if (options.forDocument && method !== "none") {
    throw new ClientError(
      "invalid_client_metadata",
      "Client metadata documents must use token_endpoint_auth_method none",
    );
  }
  // Clients may list grant types this server does not offer (Claude's published metadata also
  // lists urn:ietf:params:oauth:grant-type:jwt-bearer). Keep the ones we support and ignore the
  // rest (RFC 7591 §2: the server may reject or replace values); authorization_code is required.
  const requested = m.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(requested) || !requested.every((g) => typeof g === "string")) {
    throw new ClientError("invalid_client_metadata", "grant_types must be an array of strings");
  }
  const grantTypes = requested.filter(
    (g): g is "authorization_code" | "refresh_token" =>
      g === "authorization_code" || g === "refresh_token",
  );
  if (!grantTypes.includes("authorization_code")) {
    throw new ClientError("invalid_client_metadata", "grant_types must include authorization_code");
  }
  const responseTypes = m.response_types ?? ["code"];
  if (
    !Array.isArray(responseTypes) ||
    !responseTypes.every((r) => typeof r === "string") ||
    !responseTypes.includes("code")
  ) {
    throw new ClientError("invalid_client_metadata", "response_types must include code");
  }
  let name: string | null = null;
  if (m.client_name !== undefined && m.client_name !== null) {
    if (typeof m.client_name !== "string" || m.client_name.length > 200) {
      throw new ClientError("invalid_client_metadata", "client_name must be a string ≤ 200 chars");
    }
    name = m.client_name.trim() || null;
  }
  const clientUri = optionalHttpsUrl(m.client_uri, "client_uri");
  const logoUri = optionalHttpsUrl(m.logo_uri, "logo_uri");
  const scope = typeof m.scope === "string" ? m.scope.slice(0, 1000) : undefined;
  return {
    name,
    redirectUris: uris as string[],
    authMethod: method as AuthMethod,
    grantTypes: [...new Set(grantTypes as string[])],
    stored: {
      ...(clientUri ? { client_uri: clientUri } : {}),
      ...(logoUri ? { logo_uri: logoUri } : {}),
      ...(scope ? { scope } : {}),
      ...(typeof m.software_id === "string" ? { software_id: m.software_id.slice(0, 200) } : {}),
      ...(typeof m.software_version === "string"
        ? { software_version: m.software_version.slice(0, 100) }
        : {}),
    },
  };
}

export interface RegisteredClient {
  client: OAuthClient;
  /** Only for confidential clients, shown once. */
  secret: string | null;
}

/** Store a dynamically registered client. */
export async function registerClient(
  db: D1Database,
  metadata: ValidatedMetadata,
  now: number,
): Promise<RegisteredClient> {
  const id = `dgc_${randomBase62(24)}`;
  const secret = metadata.authMethod === "none" ? null : `dgcs_${randomBase62(40)}`;
  const secretHash = secret ? await hashSecret(secret) : null;
  const expiresAt = now + CLIENT_TTL_MS;
  await db
    .prepare(
      `INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, token_endpoint_auth_method, grant_types,
         metadata_url, metadata, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .bind(
      id,
      secretHash,
      metadata.name,
      JSON.stringify(metadata.redirectUris),
      metadata.authMethod,
      JSON.stringify(metadata.grantTypes),
      JSON.stringify(metadata.stored),
      now,
      expiresAt,
    )
    .run();
  return {
    secret,
    client: {
      id,
      name: metadata.name,
      redirectUris: metadata.redirectUris,
      authMethod: metadata.authMethod,
      secretHash,
      grantTypes: metadata.grantTypes,
      metadataUrl: null,
      clientUri: (metadata.stored.client_uri as string | undefined) ?? null,
      logoUri: (metadata.stored.logo_uri as string | undefined) ?? null,
      createdAt: now,
      expiresAt,
    },
  };
}

/** Whether a client_id is a metadata document URL (https with a path). */
export function isMetadataUrl(clientId: string): boolean {
  if (!clientId.startsWith("https://")) return false;
  try {
    const url = new URL(clientId);
    return url.pathname !== "/" && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

function hostIsPublic(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return false;
  if (h.endsWith(".internal") || h.endsWith(".home.arpa") || !h.includes(".")) return false;
  // IP literals are refused outright: documents must be served from a public DNS name.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[")) return false;
  return true;
}

/** Fetch and validate a client ID metadata document. */
export async function fetchClientMetadata(
  clientId: string,
  fetcher: typeof fetch = fetch,
): Promise<ValidatedMetadata> {
  const url = new URL(clientId);
  if (!hostIsPublic(url.hostname)) {
    throw new ClientError("invalid_client", "Client metadata must be served from a public host");
  }
  let res: Response;
  try {
    res = await fetcher(clientId, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn("oauth.client_metadata_fetch_failed", { host: url.hostname, error: String(err) });
    throw new ClientError("invalid_client", "Could not fetch the client metadata document");
  }
  if (res.status !== 200) {
    throw new ClientError(
      "invalid_client",
      `Client metadata document answered HTTP ${res.status} (redirects are not followed)`,
    );
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > METADATA_MAX_BYTES) {
    throw new ClientError("invalid_client", "Client metadata document is too large");
  }
  const text = await res.text();
  if (text.length > METADATA_MAX_BYTES) {
    throw new ClientError("invalid_client", "Client metadata document is too large");
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ClientError("invalid_client", "Client metadata document is not JSON");
  }
  if ((doc as { client_id?: unknown })?.client_id !== clientId) {
    throw new ClientError("invalid_client", "Client metadata client_id does not match its URL");
  }
  return validateClientMetadata(doc, { forDocument: true });
}

/**
 * Look up a client by id. Metadata-document clients are fetched on first use and refreshed after
 * a day. Returns null for unknown or expired registrations.
 */
export async function findClient(
  db: D1Database,
  clientId: string,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 2000) return null;
  const row = await db
    .prepare("SELECT * FROM oauth_clients WHERE id = ?")
    .bind(clientId)
    .first<ClientRow>();
  if (row && (row.expires_at === null || row.expires_at > now)) return rowToClient(row);
  if (!isMetadataUrl(clientId)) return null;
  const meta = await fetchClientMetadata(clientId, fetcher);
  const expiresAt = now + METADATA_CACHE_MS;
  await db
    .prepare(
      `INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, token_endpoint_auth_method, grant_types,
         metadata_url, metadata, created_at, expires_at)
       VALUES (?, NULL, ?, ?, 'none', ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris,
         grant_types = excluded.grant_types, metadata = excluded.metadata, expires_at = excluded.expires_at`,
    )
    .bind(
      clientId,
      meta.name,
      JSON.stringify(meta.redirectUris),
      JSON.stringify(meta.grantTypes),
      clientId,
      JSON.stringify(meta.stored),
      row?.created_at ?? now,
      expiresAt,
    )
    .run();
  return {
    id: clientId,
    name: meta.name,
    redirectUris: meta.redirectUris,
    authMethod: "none",
    secretHash: null,
    grantTypes: meta.grantTypes,
    metadataUrl: clientId,
    clientUri: (meta.stored.client_uri as string | undefined) ?? null,
    logoUri: (meta.stored.logo_uri as string | undefined) ?? null,
    createdAt: row?.created_at ?? now,
    expiresAt,
  };
}

/** Verify a client secret against its stored hash. */
export async function secretMatches(client: OAuthClient, secret: string): Promise<boolean> {
  if (!client.secretHash) return false;
  return timingSafeEqual(client.secretHash, await hashSecret(secret));
}
