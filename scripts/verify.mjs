#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { builtinModels, registerModel } from "../src/models/index.js";
const root = new URL("../", import.meta.url),
  read = (path) => readFile(new URL(path, root));
const manifest = JSON.parse(await read("docs/references/manifest.json")),
  covered = new Set(),
  paths = new Set();
let bytes = 0;
for (const source of manifest.documents) {
  assert.ok(!paths.has(source.path));
  paths.add(source.path);
  const data = await read(source.path);
  assert.equal(data.subarray(0, 5).toString(), "%PDF-");
  assert.ok(data.subarray(-2048).includes(Buffer.from("%%EOF")));
  assert.equal(data.length, source.bytes);
  assert.equal(createHash("sha256").update(data).digest("hex"), source.sha256);
  assert.ok(
    source.pdf_start_page >= 1 && source.pdf_start_page <= source.pages,
  );
  assert.match(source.source_url, /^https:\/\//);
  for (const id of source.chips) {
    assert.ok(builtinModels.some((m) => m.id === id));
    covered.add(id);
  }
  bytes += data.length;
}
assert.equal(paths.size, 8);
for (const model of builtinModels) {
  assert.ok(covered.has(model.id));
  assert.ok(model.sources.length);
  for (const source of model.sources) assert.ok(paths.has(source.path));
}
for (const directory of ["models", "examples"])
  for (const file of await readdir(new URL(directory + "/", root)))
    if (file.endsWith(".json"))
      registerModel(JSON.parse(await read(directory + "/" + file)));
for (const file of [
  "AGENTS.md",
  "README.md",
  "docs/DEVELOPMENT.md",
  "docs/MODEL_FORMAT.md",
  "docs/TUI.md",
])
  assert.ok((await read(file)).length > 100);
const checkWeb = process.argv.includes("--web");
if (checkWeb) {
  const html = (await read("chipsim.html")).toString();
  assert.ok(html.includes("ChipSim"));
  assert.ok(!html.includes('src=".generated/app.js"'));
  assert.ok(!html.includes('href="src/ui/styles.css"'));
  assert.ok(!html.includes("The comparison from Section 8"));
}
execFileSync(
  process.execPath,
  [
    "--test",
    ...(await readdir(new URL("test/", root)))
      .filter((file) => file.endsWith(".test.js"))
      .map((file) => new URL("test/" + file, root).pathname),
  ],
  { stdio: "inherit" },
);
if (process.platform === "win32") {
  console.log("PTY verification requires POSIX; skipped on Windows.");
} else {
  execFileSync("python3", [new URL("scripts/test-tui-pty.py", root).pathname], {
    stdio: "inherit",
    cwd: root,
  });
}
console.log(
  `Verified 8 PDF fingerprints (${(bytes / 1048576).toFixed(1)} MiB), model coverage, declarative examples, documentation, engine/builder/TUI checks${checkWeb ? ", and portable browser build" : ""}.`,
);
