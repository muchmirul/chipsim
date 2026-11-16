// Original test-only synchronization. Loaded explicitly through NODE_OPTIONS by
// disposable acceptance clients; never enabled by the product or user projects.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const directory = process.env.CHIPSIM_TEST_BARRIER_DIR;
if (directory && process.argv[1]?.endsWith("design-worker.mjs")) {
  const original = fs.writeFile;
  fs.writeFile = async function (path, ...args) {
    const result = await original.call(this, path, ...args);
    const name = String(path),
      late = process.env.CHIPSIM_TEST_BARRIER_LATE === "1";
    if (
      late
        ? name.endsWith("/SHA256SUMS") && !name.includes("/delivery/")
        : name.endsWith("/archive-precheck-request.json")
    ) {
      await original(
        join(directory, "ready"),
        JSON.stringify({ pid: process.pid, path: name }),
      );
      while (true) {
        try {
          await fs.access(join(directory, "release"));
          break;
        } catch {}
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    return result;
  };
  syncBuiltinESMExports();
}
