/**
 * CLI configuration: `~/.config/datagoat/config.json` (or `$XDG_CONFIG_HOME/datagoat`, or
 * `%APPDATA%\datagoat` on Windows; `DATAGOAT_CONFIG` overrides the file path). Written with mode
 * 0600 because it holds the token.
 *
 * Precedence for every value: command-line flag > environment variable > config file.
 *   DATAGOAT_TOKEN      account token (dft_) or website key (df_)
 *   DATAGOAT_SITE_KEY   website key (df_), used when DATAGOAT_TOKEN is unset
 *   DATAGOAT_URL        DataGoat base URL, e.g. https://analytics.example.com
 *   DATAGOAT_SITE       default website id
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Io } from "./io";

export interface ConfigFile {
  url?: string;
  token?: string;
  site?: string;
}

export function configPath(io: Io): string {
  if (io.env.DATAGOAT_CONFIG) return io.env.DATAGOAT_CONFIG;
  if (io.platform === "win32" && io.env.APPDATA) {
    return join(io.env.APPDATA, "datagoat", "config.json");
  }
  const base = io.env.XDG_CONFIG_HOME || join(io.homedir, ".config");
  return join(base, "datagoat", "config.json");
}

export async function readConfig(io: Io): Promise<ConfigFile> {
  try {
    const parsed = JSON.parse(await readFile(configPath(io), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const c = parsed as Record<string, unknown>;
    return {
      ...(typeof c.url === "string" ? { url: c.url } : {}),
      ...(typeof c.token === "string" ? { token: c.token } : {}),
      ...(typeof c.site === "string" ? { site: c.site } : {}),
    };
  } catch {
    return {};
  }
}

export async function writeConfig(io: Io, config: ConfigFile): Promise<void> {
  const path = configPath(io);
  const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  if (Object.keys(clean).length === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export function normaliseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error(`Invalid DataGoat URL: ${value}`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export interface Resolved {
  url: string | undefined;
  token: string | undefined;
  site: string | undefined;
  sources: { url: string; token: string; site: string };
}

/** Merge flags, environment and the config file. */
export function resolveSettings(
  io: Io,
  file: ConfigFile,
  flags: { url?: string | undefined; token?: string | undefined; site?: string | undefined },
): Resolved {
  const pick = (
    flag: string | undefined,
    envs: string[],
    fromFile: string | undefined,
  ): [string | undefined, string] => {
    if (flag) return [flag, "flag"];
    for (const e of envs) if (io.env[e]) return [io.env[e], e];
    if (fromFile) return [fromFile, "config"];
    return [undefined, "unset"];
  };
  const [url, urlSrc] = pick(flags.url, ["DATAGOAT_URL"], file.url);
  const [token, tokenSrc] = pick(flags.token, ["DATAGOAT_TOKEN", "DATAGOAT_SITE_KEY"], file.token);
  const [site, siteSrc] = pick(flags.site, ["DATAGOAT_SITE"], file.site);
  return {
    url: url ? normaliseUrl(url) : undefined,
    token,
    site,
    sources: { url: urlSrc, token: tokenSrc, site: siteSrc },
  };
}

export function maskToken(token: string | undefined): string {
  if (!token) return "(none)";
  const head = token.startsWith("dft_") ? 7 : 5;
  return `${token.slice(0, head)}...${token.slice(-4)}`;
}
