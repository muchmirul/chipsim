#!/usr/bin/env node
import { analyzeDocument } from "../src/model/from-document.js";
import {
  documentProfiles,
  compileDocument,
} from "../src/model/profiles/index.js";
import { extractPDFFile } from "../src/documents/extract-node.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { builtinModels, registerModel } from "../src/models/index.js";
if (process.argv.length > 2) {
  console.error("Usage: npm run verify (TUI-only verification; no options)");
  process.exit(2);
}
const root = new URL("../", import.meta.url),
  read = (path) => readFile(new URL(path, root));
execFileSync(
  process.execPath,
  [new URL("scripts/verify-licenses.mjs", root).pathname],
  {
    stdio: "inherit",
  },
);
const manifest = JSON.parse(await read("docs/references/manifest.json")),
  covered = new Set(),
  paths = new Set();
const catalog = JSON.parse(await read("docs/references/catalog.json"));
const documentIds = new Set(manifest.documents.map((doc) => doc.id));
assert.equal(documentIds.size, manifest.documents.length);
const referencedIds = new Set();
assert.equal(
  new Set(catalog.chips.map((chip) => chip.id)).size,
  catalog.chips.length,
);
for (const chip of catalog.chips) {
  assert.ok((await read(`docs/references/${chip.id}/README.md`)).length > 100);
  for (const ids of Object.values(chip.documents))
    for (const id of ids) {
      assert.ok(documentIds.has(id), `Unknown catalog document ${id}`);
      referencedIds.add(id);
    }
}
assert.deepEqual(referencedIds, documentIds);
const haveReferences = manifest.documents.every((source) =>
  existsSync(new URL(source.path, root)),
);
if (process.env.CHIPSIM_REQUIRE_REFERENCES && !haveReferences)
  throw new Error("Required private reference snapshot is incomplete.");
let bytes = 0;
for (const source of manifest.documents) {
  assert.ok(!paths.has(source.path));
  paths.add(source.path);
  if (haveReferences) {
    const data = await read(source.path);
    assert.equal(data.subarray(0, 5).toString(), "%PDF-");
    assert.ok(data.subarray(-2048).includes(Buffer.from("%%EOF")));
    assert.equal(data.length, source.bytes);
    assert.equal(
      createHash("sha256").update(data).digest("hex"),
      source.sha256,
    );
    const info = execFileSync(
      "pdfinfo",
      [new URL(source.path, root).pathname],
      {
        encoding: "utf8",
      },
    );
    assert.equal(Number(info.match(/^Pages:\s+(\d+)/m)?.[1]), source.pages);
    assert.ok(
      source.pdf_start_page >= 1 && source.pdf_start_page <= source.pages,
    );
    assert.match(source.source_url, /^https:\/\//);
    bytes += data.length;
  }
  for (const id of source.chips) {
    assert.ok(
      builtinModels.some((m) => m.id === id) ||
        documentProfiles.some((profile) => profile.id === id),
    );
    covered.add(id);
  }
}
assert.equal(paths.size, manifest.documents.length);
for (const profile of haveReferences ? documentProfiles : []) {
  assert.ok(paths.has(profile.source.path));
  const document = await extractPDFFile(
    new URL(profile.source.path, root).pathname,
  );
  const compiled = compileDocument(document, { profileId: profile.id });
  assert.equal(compiled.spec.id, profile.id);
  assert.ok(compiled.checks.every((check) => check.passed));
}
for (const source of haveReferences
  ? manifest.documents.filter((source) => source.compiler === "function-table")
  : []) {
  const document = await extractPDFFile(new URL(source.path, root).pathname);
  const analysis = analyzeDocument(document);
  assert.ok(analysis.models.length);
  assert.equal(analysis.diagnostics.length, 0);
  for (const model of analysis.models)
    assert.ok(
      model.spec.sourceTable && model.checks.every((check) => check.passed),
    );
}
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
  "docs/AGENT_WORKFLOW.md",
  "docs/AGENT_EXTENSIONS.md",
  "docs/AGENT_PROJECT.md",
  "README.md",
  "docs/DEVELOPMENT.md",
  "docs/CHANGELOG.md",
  "docs/VISUALIZATION.md",
  "docs/MODEL_FORMAT.md",
  "docs/TUI.md",
  "docs/DOCUMENT_PROFILES.md",
  "docs/ESP32_C6_PCNT.md",
  "docs/ESP32_C6_GPIO.md",
  "docs/FUNCTION_TABLES.md",
  "docs/BEHAVIOR_TABLES.md",
  "docs/REGISTER_BANKS.md",
  "docs/PROGRAMMING.md",
  "docs/EXISTING_SIMULATORS.md",
  "docs/HDL.md",
  "docs/HDL_DEBUG.md",
])
  assert.ok((await read(file)).length > 100);
execFileSync(
  process.execPath,
  [
    "--test",
    "--test-concurrency=4",
    ...(await readdir(new URL("test/", root)))
      .filter((file) => file.endsWith(".test.js"))
      .map((file) => new URL("test/" + file, root).pathname),
  ],
  { stdio: "inherit" },
);
if (process.platform === "win32") {
  console.log("PTY verification requires POSIX; skipped on Windows.");
} else {
  execFileSync(
    "python3",
    [
      new URL(
        haveReferences
          ? "scripts/test-tui-pty.py"
          : "scripts/test-sourcefree-pty.py",
        root,
      ).pathname,
    ],
    {
      stdio: "inherit",
      cwd: root,
    },
  );
  execFileSync(
    "python3",
    [new URL("scripts/test-agent-extension-pty.py", root).pathname],
    {
      stdio: "inherit",
      cwd: root,
    },
  );
}
console.log(
  `Verified ${paths.size} catalog entries, model coverage, declarative examples, documentation and engine/builder/TUI checks. Private PDF verification: ${haveReferences ? "all fingerprints and source suites passed (" + (bytes / 1048576).toFixed(1) + " MiB)" : "not run; supply CHIPSIM_REFERENCE_ROOT and run test:references -- --verify"}.`,
);
