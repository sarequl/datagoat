/** Entry: parse argv, find the command, run it, map errors to exit codes. */
import { Flags, parseArgv, UsageError } from "./args";
import { ApiError, VERSION } from "./client";
import { accountCommands } from "./commands/account";
import { aliasCommands, analyticsCommand, visitorsCommand } from "./commands/analytics";
import { completionCommand } from "./commands/completion";
import { resourceCommands } from "./commands/resources";
import { siteCommands } from "./commands/sites";
import { readConfig, resolveSettings } from "./config";
import {
  CancelledError,
  type Command,
  Ctx,
  collectFlags,
  findCommand,
  GLOBAL_FLAGS,
} from "./context";
import type { Io } from "./io";

export const COMMANDS: Command[] = [];
COMMANDS.push(
  ...accountCommands,
  ...siteCommands,
  analyticsCommand,
  visitorsCommand,
  ...resourceCommands,
  completionCommand(() => COMMANDS),
  ...aliasCommands,
);

const ALL_FLAGS = collectFlags(COMMANDS);

function flagLines(flags: Record<string, { description: string; value?: string; short?: string }>) {
  const rows = Object.entries(flags).map(([name, f]) => [
    `${f.short ? `-${f.short}, ` : ""}--${name}${f.value ? ` ${f.value}` : ""}`,
    f.description,
  ]);
  const width = Math.max(0, ...rows.map(([a]) => (a ?? "").length));
  return rows.map(([a, b]) => `  ${(a ?? "").padEnd(width)}  ${b}`).join("\n");
}

function commandLines(cmds: readonly Command[]) {
  const visible = cmds.filter((c) => !c.hidden);
  const width = Math.max(0, ...visible.map((c) => c.name.length));
  return visible.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join("\n");
}

export function helpText(path: string[], command: Command | null): string {
  if (!command) {
    return `datagoat ${VERSION}: DataGoat analytics from the terminal

Usage: datagoat <command> [subcommand] [flags]

Commands:
${commandLines(COMMANDS)}

Global flags:
${flagLines(GLOBAL_FLAGS)}

Start with: datagoat login --url https://your-datagoat.example
Docs: https://github.com/sarequl/datagoat/blob/main/docs/cli.md
`;
  }
  const parts = [
    `${command.summary}\n\nUsage: datagoat ${path.join(" ")}${command.sub ? " <subcommand>" : ""}${command.usage ? ` ${command.usage}` : ""}`,
  ];
  if (command.aliases?.length) parts.push(`Aliases: ${command.aliases.join(", ")}`);
  if (command.sub) parts.push(`Subcommands:\n${commandLines(command.sub)}`);
  if (command.flags && Object.keys(command.flags).length)
    parts.push(`Flags:\n${flagLines(command.flags)}`);
  parts.push("Global flags: --json --site <id> --url <url> --token <t> --verbose --yes --help");
  return `${parts.join("\n\n")}\n`;
}

/** Run the CLI. Returns the exit code (0 ok, 1 API/runtime error, 2 usage error, 130 cancelled). */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseArgv>;
  try {
    parsed = parseArgv(argv, ALL_FLAGS);
  } catch (err) {
    io.stderr(`datagoat: ${(err as Error).message}\n`);
    return 2;
  }
  const flags = new Flags(parsed.flags);
  if (flags.bool("version")) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  const positionals = [...parsed.positionals];
  if (positionals[0] === "help") {
    positionals.shift();
    parsed.flags.set("help", true);
  }
  const path: string[] = [];
  let list: readonly Command[] = COMMANDS;
  let command: Command | null = null;
  while (positionals.length) {
    const next = findCommand(list, positionals[0] as string);
    if (!next) break;
    positionals.shift();
    command = next;
    path.push(next.name);
    if (!next.sub) break;
    list = next.sub;
  }
  if (!command) {
    if (positionals.length) {
      io.stderr(`datagoat: unknown command "${positionals[0]}". Run datagoat --help.\n`);
      return 2;
    }
    io.stdout(helpText([], null));
    return 0;
  }
  if (flags.bool("help") || !command.run) {
    if (!command.run && positionals.length && !flags.bool("help")) {
      io.stderr(`datagoat: unknown subcommand "${positionals[0]}" for ${path.join(" ")}\n`);
      io.stderr(helpText(path, command));
      return 2;
    }
    io.stdout(helpText(path, command));
    return 0;
  }
  const allowed = new Set([...Object.keys(GLOBAL_FLAGS), ...Object.keys(command.flags ?? {})]);
  const stray = flags.names().filter((f) => !allowed.has(f));
  if (stray.length) {
    io.stderr(`datagoat: ${path.join(" ")} does not take --${stray.join(", --")}\n`);
    return 2;
  }
  const file = await readConfig(io);
  const settings = resolveSettings(io, file, {
    url: flags.string("url"),
    token: flags.string("token"),
    site: flags.string("site") ?? flags.string("website") ?? flags.string("website-id"),
  });
  const ctx = new Ctx(io, flags, positionals, settings, file, path);
  try {
    await command.run(ctx);
    return 0;
  } catch (err) {
    if (err instanceof CancelledError) {
      io.stderr("Cancelled.\n");
      return 130;
    }
    if (err instanceof UsageError) {
      io.stderr(`datagoat: ${err.message}\n`);
      return 2;
    }
    if (err instanceof ApiError) {
      io.stderr(`Error${err.status ? ` (${err.status})` : ""}: ${err.message}\n`);
      return 1;
    }
    io.stderr(`datagoat: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}
