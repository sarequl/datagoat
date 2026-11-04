/** login, logout, whoami, config. */
import { Client } from "../client";
import { configPath, maskToken, normaliseUrl, readConfig, writeConfig } from "../config";
import { type Command, type Ctx, UsageError } from "../context";

async function readToken(ctx: Ctx, url: string): Promise<string> {
  const flag = ctx.flags.string("token");
  if (flag) return flag.trim();
  if (!ctx.io.interactive) {
    const piped = (await ctx.io.readStdin()).trim();
    if (piped) return piped;
    throw new UsageError("Pass --token, pipe the token on stdin, or run login in a terminal.");
  }
  const page = `${url}/app/account`;
  ctx.info(
    `Create an account token (dft_…) in DataGoat: Account → API tokens\n  ${page}\nA website key (df_…) also works for analytics on one website.`,
  );
  if (ctx.flags.bool("open") !== false) ctx.io.openUrl(page);
  const prompt = ctx.io.prompt;
  if (!prompt) throw new UsageError("Pass --token");
  return (await prompt("Paste your token: ", { hidden: true })).trim();
}

const login: Command = {
  name: "login",
  summary: "Save a DataGoat URL and token (dft_ account token or df_ website key)",
  usage: "[--url <url>] [--token <token>]",
  flags: {
    open: {
      type: "boolean",
      description: "Open the token page in a browser (default; --no-open skips)",
    },
  },
  run: async (ctx) => {
    let url = ctx.flags.string("url") ?? ctx.io.env.DATAGOAT_URL ?? ctx.file.url;
    if (!url && ctx.io.prompt) {
      url = (await ctx.io.prompt("DataGoat URL (e.g. https://analytics.example.com): ")).trim();
    }
    if (!url) throw new UsageError("Pass --url <your DataGoat URL> (or set DATAGOAT_URL).");
    url = normaliseUrl(url);
    const token = await readToken(ctx, url);
    if (!/^dft?_[A-Za-z0-9]+$/.test(token)) {
      throw new UsageError("That does not look like a DataGoat token (dft_… or df_…).");
    }
    const client = new Client({ baseUrl: url, token, fetch: ctx.io.fetch });
    const me = await client.me();
    const file = await readConfig(ctx.io);
    await writeConfig(ctx.io, { ...file, url, token });
    const kind = token.startsWith("df_") ? "website key" : "account token";
    ctx.done(`Logged in to ${url} as ${me.user.email} (${kind}).`, {
      url,
      email: me.user.email,
      authKind: me.authKind,
      configPath: configPath(ctx.io),
    });
  },
};

const logout: Command = {
  name: "logout",
  summary: "Remove the saved token",
  run: async (ctx) => {
    const file = await readConfig(ctx.io);
    const { token: _t, ...rest } = file;
    await writeConfig(ctx.io, rest);
    ctx.done(`Logged out. Removed the token from ${configPath(ctx.io)}.`);
  },
};

const whoami: Command = {
  name: "whoami",
  summary: "Show the account and credential in use",
  run: async (ctx) => {
    const client = ctx.client();
    const [me, account] = await Promise.all([client.me(), client.account()]);
    const out = {
      email: account.email,
      name: account.name,
      credential: me.authKind,
      ...(account.websiteId ? { websiteId: account.websiteId } : {}),
      url: client.baseUrl,
      websites: me.websites.map((w) => `${w.name ?? w.domain} (${w._id}, ${w.role})`),
    };
    if (ctx.json) ctx.out(`${JSON.stringify({ ...out, websites: me.websites })}\n`);
    else ctx.print(out);
  },
};

const config: Command = {
  name: "config",
  summary: "Show or change the local configuration",
  sub: [
    {
      name: "show",
      summary: "Show the active URL, token, default website and config path",
      run: async (ctx) => {
        const s = ctx.settings;
        ctx.print({
          url: s.url ?? "(none)",
          urlFrom: s.sources.url,
          token: maskToken(s.token),
          tokenFrom: s.sources.token,
          site: s.site ?? "(none)",
          siteFrom: s.sources.site,
          configPath: configPath(ctx.io),
        });
      },
    },
    {
      name: "set-site",
      aliases: ["set-website"],
      summary: "Save a default website",
      usage: "<websiteId>",
      run: async (ctx) => {
        const id = await ctx.arg(0, "<websiteId>", "Website id");
        await writeConfig(ctx.io, { ...(await readConfig(ctx.io)), site: id });
        ctx.done(`Default website set to ${id}.`);
      },
    },
    {
      name: "clear-site",
      aliases: ["clear-website"],
      summary: "Remove the default website",
      run: async (ctx) => {
        const { site: _s, ...rest } = await readConfig(ctx.io);
        await writeConfig(ctx.io, rest);
        ctx.done("Default website cleared.");
      },
    },
    {
      name: "set-url",
      summary: "Save the DataGoat URL",
      usage: "<url>",
      run: async (ctx) => {
        const url = normaliseUrl(await ctx.arg(0, "<url>", "DataGoat URL"));
        await writeConfig(ctx.io, { ...(await readConfig(ctx.io)), url });
        ctx.done(`URL set to ${url}.`);
      },
    },
    {
      name: "path",
      summary: "Print the config file path",
      run: async (ctx) => ctx.out(`${configPath(ctx.io)}\n`),
    },
  ],
};

export const accountCommands: Command[] = [login, logout, whoami, config];
