import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockServer, type Sandbox, sandbox } from "./harness";

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.cleanup());

describe("shell completion", () => {
  it.each(["bash", "zsh", "fish"])(
    "prints a %s script listing commands and subcommands",
    async (shell) => {
      const res = await sb.run(["completion", shell]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("analytics");
      expect(res.stdout).toContain("timeseries");
      expect(res.stdout).toContain(shell === "fish" ? "-l period" : "--period");
      expect(res.stdout).not.toContain(" stats ");
    },
  );

  it("installs and uninstalls for bash", async () => {
    const res = await sb.run(["completion", "install", "--shell", "bash"]);
    expect(res.code, res.stderr).toBe(0);
    const rc = await readFile(join(sb.home, ".bashrc"), "utf8");
    expect(rc).toContain("# >>> datagoat completion >>>");
    const script = join(sb.home, ".config", "datagoat", "completion.bash");
    expect(await readFile(script, "utf8")).toContain("complete -F _datagoat datagoat");
    // Installing twice keeps one block.
    await sb.run(["completion", "install", "--shell", "bash"]);
    const again = await readFile(join(sb.home, ".bashrc"), "utf8");
    expect(again.split("# >>> datagoat completion >>>").length).toBe(2);
    await sb.run(["completion", "uninstall", "--shell", "bash"]);
    expect(await readFile(join(sb.home, ".bashrc"), "utf8")).not.toContain("datagoat");
    await expect(stat(script)).rejects.toThrow();
  });

  it("installs for zsh (from $SHELL) and fish", async () => {
    const zsh = await sb.run(["completion", "install"], { env: { SHELL: "/bin/zsh" } });
    expect(zsh.code, zsh.stderr).toBe(0);
    expect(await readFile(join(sb.home, ".zshrc"), "utf8")).toContain("completion.zsh");
    const fish = await sb.run(["completion", "install", "--shell", "fish"]);
    expect(fish.code).toBe(0);
    const file = join(sb.home, ".config", "fish", "completions", "datagoat.fish");
    expect(await readFile(file, "utf8")).toContain("complete -c datagoat");
    const unknown = await sb.run(["completion", "install"], { env: { SHELL: "/bin/tcsh" } });
    expect(unknown.code).toBe(2);
  });
});

describe("built package", () => {
  const cli = fileURLToPath(new URL("..", import.meta.url));
  const exec = promisify(execFile);
  let server: MockServer;

  beforeAll(async () => {
    await exec(process.execPath, [join(cli, "build.mjs")]);
  }, 60_000);

  it("runs through bin/datagoat.mjs against a server", async () => {
    server = new MockServer();
    await server.start();
    server.data("GET", "/api/v1/admin/websites", [{ _id: "s1", domain: "a.com" }]);
    try {
      const pkg = JSON.parse(await readFile(join(cli, "package.json"), "utf8"));
      expect(pkg.name).toBe("datagoat");
      expect(pkg.bin.datagoat).toBe("./bin/datagoat.mjs");
      const version = await exec(process.execPath, [join(cli, "bin", "datagoat.mjs"), "--version"]);
      expect(version.stdout.trim()).toBe(pkg.version);
      const res = await exec(
        process.execPath,
        [join(cli, "bin", "datagoat.mjs"), "--json", "sites", "list"],
        {
          env: {
            ...process.env,
            DATAGOAT_URL: server.url,
            DATAGOAT_TOKEN: "dft_x",
            XDG_CONFIG_HOME: sb.home,
          },
        },
      );
      expect(JSON.parse(res.stdout)).toEqual([{ _id: "s1", domain: "a.com" }]);
      expect(server.last().headers["user-agent"]).toBe(`datagoat-cli/${pkg.version}`);
    } finally {
      await server.stop();
    }
  });
});
