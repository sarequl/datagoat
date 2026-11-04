/** Process boundary of the CLI, injectable for tests. */
import { homedir } from "node:os";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Read all of stdin (piped input). */
  readStdin(): Promise<string>;
  /** Ask a question on the terminal; `hidden` masks the answer. Null when not interactive. */
  prompt: ((question: string, options?: { hidden?: boolean }) => Promise<string>) | null;
  /** stdin and stderr are terminals. */
  interactive: boolean;
  /** stdout is a terminal (colours, tables). */
  tty: boolean;
  env: Record<string, string | undefined>;
  homedir: string;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
  now(): number;
  /** Best-effort: open a URL in the user's browser. */
  openUrl(url: string): void;
}

export function processIo(): Io {
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString("utf8");
    },
    prompt: interactive ? terminalPrompt : null,
    interactive,
    tty: Boolean(process.stdout.isTTY),
    env: process.env,
    homedir: homedir(),
    platform: process.platform,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    openUrl: (url) => {
      void import("node:child_process").then(({ spawn }) => {
        const cmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "cmd"
              : "xdg-open";
        const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
        try {
          spawn(cmd, args, { stdio: "ignore", detached: true })
            .on("error", () => {})
            .unref();
        } catch {
          // no browser available: the URL is printed anyway
        }
      });
    },
  };
}

async function terminalPrompt(
  question: string,
  options: { hidden?: boolean } = {},
): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (options.hidden) {
    // Echo nothing while the secret is typed.
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    let asked = false;
    out._writeToOutput = (s: string) => {
      if (!asked) {
        process.stderr.write(s);
        asked = true;
      }
    };
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.question(question, resolve);
      rl.on("SIGINT", () => reject(new Error("Cancelled")));
    });
  } finally {
    if (options.hidden) process.stderr.write("\n");
    rl.close();
  }
}
