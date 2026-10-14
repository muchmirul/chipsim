import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import manifest from "../docs/references/manifest.json" with { type: "json" };

const root = new URL("../", import.meta.url);
const privateFixtures = manifest.documents.every((source) =>
  existsSync(new URL(source.path, root)),
);
for (const name of [
  privateFixtures ? "test-tui-pty.py" : "test-sourcefree-pty.py",
  "test-agent-extension-pty.py",
]) {
  const result = spawnSync(
    "python3",
    [new URL(name, import.meta.url).pathname],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
