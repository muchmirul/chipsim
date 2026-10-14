#!/usr/bin/env node
// Source-backed checks use explicitly supplied private originals, never a
// publisher download or a generated substitute. Temporary links are ignored
// by Git and npm and removed even when the test command fails.
import {
  readFile,
  mkdir,
  symlink,
  unlink,
  lstat,
  readdir,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import manifest from "../docs/references/manifest.json" with { type: "json" };

const root = resolve(import.meta.dirname, "..");
const privateRoot = process.env.CHIPSIM_REFERENCE_ROOT;
if (!privateRoot) {
  console.error(
    "Set CHIPSIM_REFERENCE_ROOT to a private directory containing the catalog's docs/references/ paths. No manuals are downloaded.",
  );
  process.exit(2);
}
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--verify")) {
  console.error("Usage: npm run test:references [-- --verify]");
  process.exit(2);
}
const links = [];
try {
  // Validate the entire snapshot before creating a link or starting any tests.
  for (const source of manifest.documents) {
    const path = resolve(privateRoot, source.path);
    const data = await readFile(path);
    if (createHash("sha256").update(data).digest("hex") !== source.sha256)
      throw new Error("Private reference fingerprint changed: " + source.id);
  }
  for (const source of manifest.documents) {
    const destination = resolve(root, source.path);
    try {
      await lstat(destination);
      const bytes = await readFile(destination);
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
        throw new Error(
          "Existing local fixture differs; it will not be overwritten: " +
            destination,
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(dirname(destination), { recursive: true });
      await symlink(resolve(privateRoot, source.path), destination);
      links.push(destination);
    }
  }
  const testFiles = (await readdir(resolve(root, "test")))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => "test/" + name);
  const child = spawn(
    process.execPath,
    args[0] === "--verify"
      ? ["scripts/verify.mjs"]
      : ["--test", "--test-concurrency=4", ...testFiles],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CHIPSIM_REQUIRE_REFERENCES: "1" },
    },
  );
  const cancel = () => child.kill("SIGTERM");
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    process.exitCode = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => done(code ?? 1));
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
} finally {
  for (const path of links) await unlink(path);
}
