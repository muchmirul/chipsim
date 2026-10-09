import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["--test", new URL("../test/hdl.test.js", import.meta.url).pathname],
  {
    stdio: "inherit",
    env: { ...process.env, CHIPSIM_TEST_HDL: "1" },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0 && process.platform !== "win32") {
  const terminal = spawnSync(
    "python3",
    [new URL("./test-hdl-pty.py", import.meta.url).pathname],
    { stdio: "inherit" },
  );
  if (terminal.error) throw terminal.error;
  process.exitCode = terminal.status ?? 1;
}
