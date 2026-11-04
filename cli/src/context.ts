/** Command definitions and the per-run context handed to each command. */
import { type FlagSpec, Flags, UsageError } from "./args";
import { ApiError, Client } from "./client";
import type { ConfigFile, Resolved } from "./config";
import type { Io } from "./io";
import { type Column, print } from "./output";

export interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  /** e.g. "<funnelId> [--name <name>]" */
  usage?: string;
  flags?: Record<string, FlagSpec>;
  sub?: Command[];
  run?: (ctx: Ctx) => Promise<void>;
  /** Hidden from help and completion (aliases such as `stats`). */
  hidden?: boolean;
}

export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: "boolean", description: "Compact JSON output (the response data), for jq" },
  site: {
    type: "string",
    value: "<id>",
    description: "Website id or tracking id (default: config)",
  },
  website: { type: "string", value: "<id>", description: "Alias for --site" },
  "website-id": { type: "string", value: "<id>", description: "Alias for --site" },
  url: {
    type: "string",
    value: "<url>",
    description: "DataGoat URL (default: config / DATAGOAT_URL)",
  },
  token: { type: "string", value: "<token>", description: "Use this token for one command" },
  verbose: { type: "boolean", description: "Print each request and status to stderr" },
  yes: { type: "boolean", short: "y", description: "Skip confirmation prompts" },
  help: { type: "boolean", short: "h", description: "Show help" },
  version: { type: "boolean", short: "V", description: "Print the CLI version" },
};

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
  }
}

export class Ctx {
  private cachedClient: Client | undefined;
  private keySite: string | undefined;

  constructor(
    readonly io: Io,
    readonly flags: Flags,
    readonly args: string[],
    readonly settings: Resolved,
    readonly file: ConfigFile,
    readonly commandPath: string[],
  ) {}

  get json(): boolean {
    return this.flags.bool("json") === true;
  }

  out(text: string): void {
    this.io.stdout(text);
  }

  info(text: string): void {
    this.io.stderr(`${text}\n`);
  }

  print(data: unknown, columns?: Column[]): void {
    print({ json: this.json, out: (t) => this.io.stdout(t) }, data, columns);
  }

  /** Print a message, or `{message}` JSON with --json. */
  done(message: string, extra: Record<string, unknown> = {}): void {
    if (this.json) this.out(`${JSON.stringify({ message, ...extra })}\n`);
    else this.out(`${message}\n`);
  }

  client(): Client {
    if (this.cachedClient) return this.cachedClient;
    const { url, token } = this.settings;
    if (!url) {
      throw new UsageError(
        "No DataGoat URL. Run `datagoat login`, pass --url, or set DATAGOAT_URL.",
      );
    }
    if (!token) {
      throw new UsageError("Not logged in. Run `datagoat login` or set DATAGOAT_TOKEN.");
    }
    this.cachedClient = new Client({
      baseUrl: url,
      token,
      fetch: this.io.fetch,
      ...(this.flags.bool("verbose") ? { trace: (line: string) => this.info(line) } : {}),
    });
    return this.cachedClient;
  }

  /** Positional argument `i`, prompting for it when interactive. */
  async arg(i: number, name: string, question?: string): Promise<string> {
    const value = this.args[i];
    if (value) return value;
    if (this.io.prompt) {
      const answer = (await this.io.prompt(`${question ?? name}: `)).trim();
      if (answer) return answer;
    }
    throw new UsageError(`Missing ${name}. Usage: datagoat ${this.commandPath.join(" ")} ${name}`);
  }

  /** A required string flag, prompting for it when interactive. */
  async need(flag: string, question: string): Promise<string> {
    const value = this.flags.string(flag);
    if (value) return value;
    if (this.io.prompt) {
      const answer = (await this.io.prompt(`${question}: `)).trim();
      if (answer) return answer;
    }
    throw new UsageError(`--${flag} is required`);
  }

  /** Ask before destructive actions; --yes skips. */
  async confirm(message: string): Promise<void> {
    if (this.flags.bool("yes")) return;
    if (!this.io.prompt) {
      throw new UsageError(`${message} Pass --yes to confirm in a non-interactive shell.`);
    }
    const answer = (await this.io.prompt(`${message} [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new CancelledError();
  }

  private explicitSite(): string | undefined {
    return (
      this.flags.string("site") ??
      this.flags.string("website") ??
      this.flags.string("website-id") ??
      this.settings.site
    );
  }

  get isSiteKey(): boolean {
    return this.settings.token?.startsWith("df_") === true;
  }

  /** The website for path-scoped endpoints (`/admin/websites/:id/...`). */
  async site(): Promise<string> {
    const explicit = this.explicitSite();
    if (explicit) return explicit;
    if (this.isSiteKey) {
      this.keySite ??= (await this.client().account()).websiteId;
      if (this.keySite) return this.keySite;
    }
    if (this.io.prompt) {
      const sites = await this.client().websites();
      if (sites.length === 1 && sites[0]) return sites[0]._id;
      if (sites.length === 0) throw new UsageError("This account has no websites yet.");
      this.io.stderr(
        `${sites.map((s, i) => `  ${i + 1}) ${s.name ?? s.domain} (${s.domain}) ${s._id}`).join("\n")}\n`,
      );
      const answer = (await this.io.prompt("Website number: ")).trim();
      const pick = sites[Number(answer) - 1];
      if (!pick) throw new CancelledError();
      return pick._id;
    }
    throw new UsageError(
      "Which website? Pass --site <websiteId> or set a default with `datagoat config set-site <websiteId>`.",
    );
  }

  /** The website for `?websiteId=` endpoints; omitted with a df_ key (the API infers it). */
  async siteQuery(): Promise<string | undefined> {
    const explicit = this.explicitSite();
    if (explicit) return explicit;
    if (this.isSiteKey) return undefined;
    return this.site();
  }

  /** Timezone used to resolve --period presets. */
  async timezoneFor(site: string | undefined): Promise<string> {
    try {
      const sites = await this.client().websites();
      const match = sites.find((s) => !site || s._id === site || s.trackingId === site);
      if (match?.timezone) return match.timezone;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
}

/** Every flag of every command plus the globals (one type per flag name). */
export function collectFlags(commands: readonly Command[]): Map<string, FlagSpec> {
  const all = new Map<string, FlagSpec>(Object.entries(GLOBAL_FLAGS));
  const walk = (cmds: readonly Command[]) => {
    for (const c of cmds) {
      for (const [name, spec] of Object.entries(c.flags ?? {})) {
        const prev = all.get(name);
        if (prev && prev.type !== spec.type) {
          throw new Error(`Flag --${name} is declared with two types`);
        }
        if (!prev) all.set(name, spec);
      }
      if (c.sub) walk(c.sub);
    }
  };
  walk(commands);
  return all;
}

export function findCommand(list: readonly Command[], name: string): Command | undefined {
  return list.find((c) => c.name === name || c.aliases?.includes(name));
}

export { Flags, UsageError };
