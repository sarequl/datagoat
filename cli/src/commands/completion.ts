/**
 * Shell completion for bash, zsh and fish, generated from the command tree.
 *
 *   datagoat completion bash|zsh|fish   print the script
 *   datagoat completion install         write it to ~/.config/datagoat/ and source it from the
 *                                       shell's init file (fish: its completions directory)
 *   datagoat completion uninstall       undo install
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Command } from "../context";
import { GLOBAL_FLAGS, UsageError } from "../context";
import type { Io } from "../io";

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

const BEGIN = "# >>> datagoat completion >>>";
const END = "# <<< datagoat completion <<<";

interface Tree {
  top: string[];
  subs: Record<string, string[]>;
  flags: string[];
}

function tree(commands: readonly Command[]): Tree {
  const visible = commands.filter((c) => !c.hidden);
  const subs: Record<string, string[]> = {};
  for (const c of visible) {
    if (!c.sub) continue;
    const names = c.sub.map((s) => s.name);
    for (const n of [c.name, ...(c.aliases ?? [])]) subs[n] = names;
  }
  const flags = new Set(Object.keys(GLOBAL_FLAGS).map((f) => `--${f}`));
  const walk = (cmds: readonly Command[]) => {
    for (const c of cmds) {
      for (const f of Object.keys(c.flags ?? {})) flags.add(`--${f}`);
      if (c.sub) walk(c.sub);
    }
  };
  walk(commands);
  return {
    top: visible.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
    subs,
    flags: [...flags].sort(),
  };
}

export function completionScript(shell: Shell, commands: readonly Command[]): string {
  const t = tree(commands);
  if (shell === "bash") {
    const cases = Object.entries(t.subs)
      .map(([cmd, subs]) => `    ${cmd}) words="${subs.join(" ")}" ;;`)
      .join("\n");
    return `# datagoat bash completion
_datagoat() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" words=""
  if [[ "$cur" == -* ]]; then
    words="${t.flags.join(" ")}"
  elif [[ $COMP_CWORD -eq 1 ]]; then
    words="${t.top.join(" ")}"
  elif [[ $COMP_CWORD -eq 2 ]]; then
    case "\${COMP_WORDS[1]}" in
${cases}
    esac
  fi
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -F _datagoat datagoat
`;
  }
  if (shell === "zsh") {
    const cases = Object.entries(t.subs)
      .map(([cmd, subs]) => `      ${cmd}) compadd -- ${subs.join(" ")} ;;`)
      .join("\n");
    return `#compdef datagoat
# datagoat zsh completion
_datagoat() {
  if [[ "$PREFIX" == -* ]]; then
    compadd -- ${t.flags.join(" ")}
  elif (( CURRENT == 2 )); then
    compadd -- ${t.top.join(" ")}
  elif (( CURRENT == 3 )); then
    case "$words[2]" in
${cases}
    esac
  fi
}
if (( $+functions[compdef] )); then
  compdef _datagoat datagoat
fi
`;
  }
  const lines = [
    "# datagoat fish completion",
    "complete -c datagoat -f",
    `complete -c datagoat -n __fish_use_subcommand -a "${t.top.join(" ")}"`,
    ...Object.entries(t.subs).map(
      ([cmd, subs]) =>
        `complete -c datagoat -n "__fish_seen_subcommand_from ${cmd}" -a "${subs.join(" ")}"`,
    ),
    ...t.flags.map((f) => `complete -c datagoat -l ${f.slice(2)}`),
  ];
  return `${lines.join("\n")}\n`;
}

function detectShell(io: Io, flag: string | undefined): Shell {
  const name = flag ?? io.env.SHELL?.split("/").pop();
  if (name && (SHELLS as readonly string[]).includes(name)) return name as Shell;
  throw new UsageError("Could not detect your shell; pass --shell bash|zsh|fish");
}

function paths(io: Io, shell: Shell) {
  const configDir = join(io.env.XDG_CONFIG_HOME || join(io.homedir, ".config"));
  if (shell === "fish") {
    return { script: join(configDir, "fish", "completions", "datagoat.fish"), rc: null };
  }
  const rc =
    shell === "zsh"
      ? join(io.env.ZDOTDIR || io.homedir, ".zshrc")
      : join(io.homedir, io.platform === "darwin" ? ".bash_profile" : ".bashrc");
  return { script: join(configDir, "datagoat", `completion.${shell}`), rc };
}

async function readOr(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function stripBlock(text: string): string {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return text;
  return (text.slice(0, start) + text.slice(end + END.length)).replace(/\n{3,}/g, "\n\n");
}

export async function installCompletion(io: Io, shell: Shell, commands: readonly Command[]) {
  const p = paths(io, shell);
  await mkdir(dirname(p.script), { recursive: true });
  await writeFile(p.script, completionScript(shell, commands));
  if (p.rc) {
    const current = stripBlock(await readOr(p.rc));
    const block = `${BEGIN}\n[ -f "${p.script}" ] && . "${p.script}"\n${END}\n`;
    await writeFile(p.rc, `${current.replace(/\n*$/, current ? "\n\n" : "")}${block}`);
  }
  return p;
}

export async function uninstallCompletion(io: Io, shell: Shell) {
  const p = paths(io, shell);
  await rm(p.script, { force: true });
  if (p.rc) {
    const current = await readOr(p.rc);
    if (current.includes(BEGIN)) await writeFile(p.rc, stripBlock(current));
  }
  return p;
}

export function completionCommand(commands: () => readonly Command[]): Command {
  const shellFlag = {
    shell: {
      type: "string" as const,
      value: "<shell>",
      description: "bash, zsh or fish (default: $SHELL)",
    },
  };
  return {
    name: "completion",
    summary: "Shell completion (bash, zsh, fish)",
    sub: [
      ...SHELLS.map(
        (shell): Command => ({
          name: shell,
          summary: `Print the ${shell} completion script`,
          run: async (ctx) => ctx.out(completionScript(shell, commands())),
        }),
      ),
      {
        name: "install",
        summary: "Install completion into your shell's init file",
        flags: shellFlag,
        run: async (ctx) => {
          const shell = detectShell(ctx.io, ctx.flags.string("shell"));
          const p = await installCompletion(ctx.io, shell, commands());
          ctx.done(
            p.rc
              ? `Installed ${shell} completion (${p.script}, sourced from ${p.rc}). Restart your shell or run: . ${p.rc}`
              : `Installed fish completion at ${p.script}.`,
          );
        },
      },
      {
        name: "uninstall",
        summary: "Remove the installed completion",
        flags: shellFlag,
        run: async (ctx) => {
          const shell = detectShell(ctx.io, ctx.flags.string("shell"));
          await uninstallCompletion(ctx.io, shell);
          ctx.done(`Removed ${shell} completion.`);
        },
      },
    ],
  };
}
