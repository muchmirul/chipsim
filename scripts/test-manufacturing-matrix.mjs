import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cache =
  process.env.CHIPSIM_MANUFACTURING_CACHE ||
  (await mkdtemp(join(tmpdir(), "chipsim-matrix-cache-")));
console.log("Shared matrix cache:", cache);
for (const fixture of ["counter", "power", "fifo", "uart"]) {
  const r = spawnSync(
    process.execPath,
    [
      "--test",
      new URL("../test/manufacturing-mcp.test.js", import.meta.url).pathname,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CHIPSIM_TEST_MANUFACTURING: "1",
        CHIPSIM_TEST_MANUFACTURING_RACES: "1",
        CHIPSIM_MANUFACTURING_FIXTURE: fixture,
        CHIPSIM_MANUFACTURING_CACHE: cache,
      },
    },
  );
  if (r.status !== 0) {
    process.exitCode = r.status ?? 1;
    break;
  }
}

if (!process.exitCode) {
  const r = spawnSync(
    process.execPath,
    [
      "--test",
      new URL("../test/workflow-native.test.js", import.meta.url).pathname,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CHIPSIM_TEST_MANUFACTURING: "1",
        CHIPSIM_MANUFACTURING_CACHE: cache,
      },
    },
  );
  if (r.status !== 0) process.exitCode = r.status ?? 1;
}
