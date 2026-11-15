import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  [
    "--test",
    new URL("../test/manufacturing-mcp.test.js", import.meta.url).pathname,
  ],
  {
    stdio: "inherit",
    env: { ...process.env, CHIPSIM_TEST_MANUFACTURING: "1" },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
