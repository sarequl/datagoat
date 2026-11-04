/** Bundle entry (dist/datagoat.mjs): run the CLI against the real process. */
import { processIo } from "./io";
import { main } from "./main";

export async function run(): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    process.stderr.write(`datagoat needs Node.js 20 or newer (this is ${process.version}).\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await main(process.argv.slice(2), processIo());
}
