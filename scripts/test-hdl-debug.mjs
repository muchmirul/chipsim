#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["--test", "test/hdl-debug.test.js", "test/hdl-debug-backends.test.js"],
  {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
    env: { ...process.env, CHIPSIM_TEST_HDL_DEBUG: "1" },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0 && process.platform !== "win32") {
  const terminal = spawnSync(
    "python3",
    [new URL("./test-hdl-debug-pty.py", import.meta.url).pathname],
    { stdio: "inherit" },
  );
  if (terminal.error) throw terminal.error;
  process.exitCode = terminal.status ?? 1;
}
