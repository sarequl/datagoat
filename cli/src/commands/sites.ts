/** sites (websites), keys (df_ website keys), tokens (dft_ account tokens), team. */
import { readConfig, writeConfig } from "../config";
import { type Command, type Ctx, UsageError } from "../context";

const SITE_COLUMNS = [
  { key: "_id", label: "id" },
  { key: "domain" },
  { key: "name" },
  { key: "trackingId", label: "tracking id" },
  { key: "timezone" },
  { key: "role" },
];

/** --set key=value pairs → update body (JSON values allowed: true, 42, ["a"]). */
function parseSets(values: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new UsageError(`--set expects key=value, got "${raw}"`);
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

const list = (v: string | undefined) =>
  v === undefined
    ? undefined
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

const bool = (ctx: Ctx, name: string): boolean | undefined => {
  const v = ctx.flags.string(name);
  if (v === undefined) return undefined;
  if (["true", "yes", "1", "on"].includes(v)) return true;
  if (["false", "no", "0", "off"].includes(v)) return false;
  throw new UsageError(`--${name} takes true or false`);
};

const UPDATE_FLAGS = {
  name: { type: "string", value: "<name>", description: "Display name" },
  domain: { type: "string", value: "<domain>", description: "Domain" },
  timezone: { type: "string", value: "<tz>", description: "IANA timezone" },
  currency: { type: "string", value: "<ISO>", description: "Reporting currency, e.g. USD" },
  kpi: { type: "string", value: "<goal|revenue>", description: "#1 KPI: revenue or a goal name" },
  "kpi-color-scheme": { type: "string", value: "<name>", description: "KPI colour scheme" },
  "revenue-metric": { type: "string", value: "<revenue|mrr>", description: "Revenue metric" },
  cookieless: { type: "string", value: "<true|false>", description: "Cookieless tracking" },
  "include-renewal-revenue": {
    type: "string",
    value: "<true|false>",
    description: "Count renewals in KPI revenue",
  },
  "excluded-ips": { type: "string", value: "<a,b>", description: "IPs/CIDRs to exclude" },
  "excluded-paths": { type: "string", value: "<a,b>", description: "Path globs to exclude" },
  "excluded-countries": { type: "string", value: "<a,b>", description: "Countries to exclude" },
  "allowed-hostnames": { type: "string", value: "<a,b>", description: "Extra allowed hostnames" },
  set: { type: "multi", value: "<key=value>", description: "Any other setting (JSON values)" },
} as const;

function updateBody(ctx: Ctx): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: ctx.flags.string("name"),
    domain: ctx.flags.string("domain"),
    timezone: ctx.flags.string("timezone"),
    currency: ctx.flags.string("currency"),
    kpi: ctx.flags.string("kpi"),
    kpiColorScheme: ctx.flags.string("kpi-color-scheme"),
    revenueMetric: ctx.flags.string("revenue-metric"),
    isCookieless: bool(ctx, "cookieless"),
    includeRenewalRevenue: bool(ctx, "include-renewal-revenue"),
    excludedIps: list(ctx.flags.string("excluded-ips")),
    excludedPaths: list(ctx.flags.string("excluded-paths")),
    excludedCountries: list(ctx.flags.string("excluded-countries")),
    allowedHostnames: list(ctx.flags.string("allowed-hostnames")),
    ...parseSets(ctx.flags.list("set")),
  };
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

/** The website id: first positional, else --site / config / prompt. */
async function siteArg(ctx: Ctx): Promise<string> {
  return ctx.args[0] ?? (await ctx.site());
}

export const keysCommand: Command = {
  name: "keys",
  aliases: ["apikeys"],
  summary: "Website API keys (df_)",
  sub: [
    {
      name: "list",
      summary: "List the website's keys (prefixes only)",
      run: async (ctx) => {
        const site = await ctx.site();
        ctx.print(await ctx.client().keys(site), [
          { key: "id" },
          { key: "name" },
          { key: "displayKey", label: "key" },
          { key: "includePii", label: "pii" },
          { key: "lastUsedAt", label: "last used" },
        ]);
      },
    },
    {
      name: "create",
      summary: "Create a key (the secret is shown once)",
      usage: "[--name <name>] [--pii]",
      flags: {
        name: { type: "string", value: "<name>", description: "Key name" },
        pii: { type: "boolean", description: "Allow reading customer names and emails" },
      },
      run: async (ctx) => {
        const site = await ctx.site();
        const name = ctx.flags.string("name");
        const [key] = await ctx.client().createKey(site, {
          ...(name ? { name } : {}),
          ...(ctx.flags.bool("pii") ? { includePii: true } : {}),
        });
        if (ctx.json) return ctx.out(`${JSON.stringify(key)}\n`);
        ctx.out(`${key?.key}\n`);
        ctx.info("Created. Copy the key now: it is not shown again.");
      },
    },
    {
      name: "roll",
      summary: "Replace a key's secret; the old one stops working",
      usage: "<apiKeyId>",
      run: async (ctx) => {
        const site = await ctx.site();
        const id = await ctx.arg(0, "<apiKeyId>", "API key id");
        await ctx.confirm(`Roll key ${id}? The current secret stops working immediately.`);
        const [key] = await ctx.client().rollKey(site, id);
        if (ctx.json) return ctx.out(`${JSON.stringify(key)}\n`);
        ctx.out(`${key?.key}\n`);
        ctx.info("Rolled. Copy the new key now: it is not shown again.");
      },
    },
    {
      name: "delete",
      summary: "Delete a key",
      usage: "<apiKeyId>",
      run: async (ctx) => {
        const site = await ctx.site();
        const id = await ctx.arg(0, "<apiKeyId>", "API key id");
        await ctx.confirm(`Delete key ${id}?`);
        await ctx.client().deleteKey(site, id);
        ctx.done(`Deleted key ${id}.`);
      },
    },
  ],
};

export const teamCommand: Command = {
  name: "team",
  summary: "Team members of a website",
  sub: [
    {
      name: "list",
      summary: "List members with their role",
      run: async (ctx) => {
        ctx.print(await ctx.client().team(await ctx.site()), [
          { key: "userId", label: "user id" },
          { key: "email" },
          { key: "name" },
          { key: "role" },
          { key: "joinedAt", label: "joined" },
        ]);
      },
    },
    {
      name: "invites",
      summary: "List pending invitations",
      run: async (ctx) => ctx.print(await ctx.client().invites(await ctx.site())),
    },
    {
      name: "invite",
      summary: "Invite someone by email (owners only)",
      usage: "--email <email> [--role viewer|member]",
      flags: {
        email: { type: "string", value: "<email>", description: "Email to invite" },
        role: { type: "string", value: "<role>", description: "viewer (default), member or owner" },
      },
      run: async (ctx) => {
        const site = await ctx.site();
        const email = await ctx.need("email", "Email");
        const [invite] = await ctx
          .client()
          .invite(site, email, ctx.flags.string("role") ?? "viewer");
        if (ctx.json) return ctx.out(`${JSON.stringify(invite)}\n`);
        ctx.out(
          `Invited ${email}. Share this link: ${invite?.inviteUrl ?? "(see the dashboard)"}\n`,
        );
      },
    },
    {
      name: "remove",
      summary: "Remove a member (owners only)",
      usage: "<userId>",
      run: async (ctx) => {
        const site = await ctx.site();
        const userId = await ctx.arg(0, "<userId>", "User id");
        await ctx.confirm(`Remove ${userId} from the website? Their df_ keys stop working.`);
        await ctx.client().removeMember(site, userId);
        ctx.done(`Removed ${userId}.`);
      },
    },
    {
      name: "role",
      summary: "Change a member's role (owners only)",
      usage: "<userId> --role owner|member|viewer",
      flags: { role: { type: "string", value: "<role>", description: "New role" } },
      run: async (ctx) => {
        const site = await ctx.site();
        const userId = await ctx.arg(0, "<userId>", "User id");
        const role = await ctx.need("role", "Role (owner, member, viewer)");
        await ctx.client().setRole(site, userId, role);
        ctx.done(`${userId} is now ${role}.`);
      },
    },
  ],
};

export const sitesCommand: Command = {
  name: "sites",
  aliases: ["websites", "website", "site"],
  summary: "Websites: list, inspect, create, update",
  sub: [
    {
      name: "list",
      summary: "List the websites you can access",
      run: async (ctx) => ctx.print(await ctx.client().websites(), SITE_COLUMNS),
    },
    {
      name: "get",
      summary: "Show every setting of a website",
      usage: "[websiteId]",
      run: async (ctx) => ctx.print(await ctx.client().website(await siteArg(ctx))),
    },
    {
      name: "create",
      summary: "Add a website",
      usage: "--domain <domain> --timezone <tz> [--name <name>] [--currency <ISO>]",
      flags: {
        domain: UPDATE_FLAGS.domain,
        timezone: UPDATE_FLAGS.timezone,
        name: UPDATE_FLAGS.name,
        currency: UPDATE_FLAGS.currency,
      },
      run: async (ctx) => {
        const domain = await ctx.need("domain", "Domain (example.com)");
        const timezone =
          ctx.flags.string("timezone") ??
          (ctx.io.prompt
            ? (
                await ctx.io.prompt(
                  `Timezone [${Intl.DateTimeFormat().resolvedOptions().timeZone}]: `,
                )
              ).trim() || Intl.DateTimeFormat().resolvedOptions().timeZone
            : undefined);
        if (!timezone) throw new UsageError("--timezone is required");
        const name = ctx.flags.string("name");
        const currency = ctx.flags.string("currency");
        const [created] = await ctx.client().createWebsite({
          domain,
          timezone,
          ...(name ? { name } : {}),
          ...(currency ? { currency } : {}),
        });
        if (ctx.json) return ctx.out(`${JSON.stringify(created)}\n`);
        ctx.out(
          `Created ${domain}: websiteId ${created?.websiteId}\nScript tag:\n  <script defer data-website-id="${created?.trackingId}" data-domain="${domain}" src="${ctx.client().baseUrl}/js/script.js"></script>\n`,
        );
      },
    },
    {
      name: "update",
      summary: "Change one or more settings",
      usage: "[websiteId] [--name …] [--timezone …] [--set key=value]",
      flags: UPDATE_FLAGS,
      run: async (ctx) => {
        const site = await siteArg(ctx);
        const body = updateBody(ctx);
        if (Object.keys(body).length === 0) {
          throw new UsageError("Nothing to update: pass --name, --timezone, --set key=value, …");
        }
        ctx.print(await ctx.client().updateWebsite(site, body));
      },
    },
    {
      name: "kpi",
      summary: "Set the #1 KPI (revenue or a goal)",
      usage: "[websiteId] --type revenue|goal [--goal <name>] [--revenue-metric revenue|mrr]",
      flags: {
        type: { type: "string", value: "<revenue|goal>", description: "KPI type" },
        goal: { type: "multi", value: "<value>", description: "Goal name for a goal KPI" },
        "revenue-metric": UPDATE_FLAGS["revenue-metric"],
        "color-scheme": { type: "string", value: "<name>", description: "KPI colour scheme" },
      },
      run: async (ctx) => {
        const site = await siteArg(ctx);
        const type = await ctx.need("type", "KPI type (revenue or goal)");
        const body: Record<string, unknown> = {};
        if (type === "revenue") {
          body.kpi = "revenue";
          const metric = ctx.flags.string("revenue-metric");
          if (metric) body.revenueMetric = metric;
        } else if (type === "goal") {
          const goal =
            ctx.flags.list("goal")[0] ??
            (ctx.io.prompt ? (await ctx.io.prompt("Goal name: ")).trim() : undefined);
          if (!goal) throw new UsageError("--goal <name> is required for a goal KPI");
          body.kpi = goal;
        } else throw new UsageError("--type must be revenue or goal");
        const scheme = ctx.flags.string("color-scheme");
        if (scheme) body.kpiColorScheme = scheme;
        ctx.print(await ctx.client().updateWebsite(site, body));
      },
    },
    {
      name: "delete",
      summary: "Delete a website (dashboard only; prints where to do it)",
      usage: "[websiteId]",
      run: async (ctx) => {
        const site = await siteArg(ctx);
        await ctx.confirm(`Delete website ${site}?`);
        await ctx.client().deleteWebsite(site);
        ctx.done(`Website ${site} deleted.`);
      },
    },
    {
      name: "use",
      summary: "Make a website the default for other commands",
      usage: "<websiteId>",
      run: async (ctx) => {
        const id = await ctx.arg(0, "<websiteId>", "Website id");
        await writeConfig(ctx.io, { ...(await readConfig(ctx.io)), site: id });
        ctx.done(`Default website set to ${id}.`);
      },
    },
    { ...keysCommand, name: "apikeys", aliases: [] },
    teamCommand,
  ],
};

export const tokensCommand: Command = {
  name: "tokens",
  summary: "Account access tokens (dft_)",
  sub: [
    {
      name: "list",
      summary: "List your tokens (metadata only)",
      run: async (ctx) =>
        ctx.print(await ctx.client().tokens(), [
          { key: "id" },
          { key: "name" },
          { key: "displayKey", label: "token" },
          { key: "permissions" },
          {
            key: "websiteIds",
            label: "websites",
            format: (v) => ((v as string[]).length ? (v as string[]).join(", ") : "all"),
          },
          { key: "expiresAt", label: "expires" },
        ]),
    },
    {
      name: "create",
      summary: "Create a token, never broader than the one you use (shown once)",
      usage: '--name <name> --permissions "analytics:read,websites:read" [--websites <id,id>]',
      flags: {
        name: { type: "string", value: "<name>", description: "Token name" },
        permissions: {
          type: "string",
          value: "<a,b>",
          description: 'Permissions, or "*" (default)',
        },
        websites: { type: "string", value: "<id,id>", description: "Limit to these websites" },
        pii: { type: "boolean", description: "Allow reading customer names and emails" },
        "expires-days": { type: "string", value: "<n>", description: "Expire after n days" },
      },
      run: async (ctx) => {
        const name =
          ctx.flags.string("name") ??
          (ctx.io.prompt ? (await ctx.io.prompt("Token name: ")).trim() : undefined);
        const permissions = list(ctx.flags.string("permissions")) ?? ["*"];
        const websiteIds = list(ctx.flags.string("websites"));
        const expires = ctx.flags.int("expires-days", { min: 1, max: 3650 });
        const [token] = await ctx.client().createToken({
          ...(name ? { name } : {}),
          permissions,
          ...(websiteIds ? { websiteIds } : {}),
          ...(ctx.flags.bool("pii") ? { includePii: true } : {}),
          ...(expires ? { expiresInDays: expires } : {}),
        });
        if (ctx.json) return ctx.out(`${JSON.stringify(token)}\n`);
        ctx.out(`${token?.key}\n`);
        ctx.info("Created. Copy the token now: it is not shown again.");
      },
    },
    {
      name: "delete",
      summary: "Revoke a token",
      usage: "<tokenId>",
      run: async (ctx) => {
        const id = await ctx.arg(0, "<tokenId>", "Token id");
        await ctx.confirm(`Revoke token ${id}?`);
        await ctx.client().deleteToken(id);
        ctx.done(`Revoked token ${id}.`);
      },
    },
  ],
};

export const siteCommands: Command[] = [sitesCommand, keysCommand, teamCommand, tokensCommand];
