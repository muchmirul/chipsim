// Explicit, disposable SDK acceptance fault injection. Product code never loads it.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const marker = process.env.CHIPSIM_TEST_BOOTSTRAP_CRASH_MARKER;
if (marker && process.argv.includes("mcp")) {
  const original = fs.rename;
  fs.rename = async function (from, to) {
    const result = await original.call(this, from, to);
    if (await fs.stat(marker).catch(() => null)) return result;
    const path = String(to),
      mode = process.env.CHIPSIM_TEST_BOOTSTRAP_CRASH_MODE;
    let crash = mode === "partial" && path.endsWith("/src");
    if (
      mode === "reply" &&
      /\/\.chipsim\/bootstrap-requests\/[a-f0-9]+\.json$/.test(path)
    ) {
      crash = JSON.parse(await fs.readFile(path, "utf8")).complete === true;
    }
    if (crash) {
      await fs.writeFile(
        marker,
        JSON.stringify({ pid: process.pid, mode, path }),
      );
      process.kill(process.pid, "SIGKILL");
    }
    return result;
  };
  syncBuiltinESMExports();
}
