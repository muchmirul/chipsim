#!/usr/bin/env node
// Offline inventory/notice checks. Passing is not a redistribution permission.
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { integrationContracts } from "../src/design/contracts.js";
import { existsSync } from "node:fs";
import { referencePath } from "../src/documents/references.js";

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--release")) {
  console.error("Usage: npm run test:licenses [-- --release]");
  process.exit(2);
}
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root));
const json = async (path) => JSON.parse(await read(path));
const digest = (data) => createHash("sha256").update(data).digest("hex");
const manifest = await json("docs/references/manifest.json");
const documents = await json("docs/licensing/reference-documents.json");
const software = await json("docs/licensing/software.json");
const findings = await json("docs/licensing/release-findings.json");
const pkg = await json("package.json");
const lock = await json("package-lock.json");
const sourceById = new Map(manifest.documents.map((doc) => [doc.id, doc]));
assert.equal(documents.schema_version, 1);
assert.equal(software.schema_version, 1);
assert.equal(findings.schema_version, 1);
assert.equal(documents.documents.length, sourceById.size);
assert.equal(
  new Set(documents.documents.map((doc) => doc.id)).size,
  sourceById.size,
);
assert.equal(
  new Set(software.components.map((item) => item.id)).size,
  software.components.length,
);
assert.equal(
  new Set(findings.findings.map((item) => item.id)).size,
  findings.findings.length,
);
const reviewedPDFs = new Set();
for (const doc of documents.documents) {
  const source = sourceById.get(doc.id);
  assert.ok(source, `Unknown reviewed PDF: ${doc.id}`);
  for (const key of ["path", "sha256", "publisher", "revision", "source_url"])
    assert.equal(
      doc[key],
      source[key],
      `Stale document review: ${doc.id} ${key}`,
    );
  assert.equal(
    doc.distributed,
    false,
    `Vendor bytes must remain private: ${doc.id}`,
  );
  const privatePath = referencePath(doc);
  if (existsSync(privatePath))
    assert.equal(
      digest(await readFile(privatePath)),
      doc.sha256,
      `Changed private PDF: ${doc.id}`,
    );
  assert.ok(
    ["permission-required", "conditional", "cleared"].includes(
      doc.redistribution,
    ),
  );
  assert.ok(doc.license && doc.assessment && doc.reviewed_on);
  assert.ok(doc.notice_pdf_pages.length);
  for (const page of doc.notice_pdf_pages)
    assert.ok(Number.isInteger(page) && page >= 1 && page <= source.pages);
  // A cleared review must cite permission evidence, not only a status string.
  if (doc.redistribution === "cleared")
    assert.ok(doc.permission_evidence?.length);
  reviewedPDFs.add(doc.path);
}
async function files(path) {
  const result = [];
  for (const entry of await readdir(new URL(path + "/", root), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".")) continue;
    const child = path + "/" + entry.name;
    if (entry.isDirectory()) result.push(...(await files(child)));
    else result.push(child);
  }
  return result;
}
for (const path of (await files("docs/references")).filter((p) =>
  p.endsWith(".pdf"),
))
  assert.ok(reviewedPDFs.has(path), `Unreviewed PDF: ${path}`);
const coveredAdapters = new Set();
const componentIds = new Set();
let copiedFiles = 0;
for (const item of software.components) {
  componentIds.add(item.id);
  assert.ok(
    item.license && item.relationship && item.notes && item.reviewed_on,
  );
  assert.ok(item.evidence.length && item.locations.length);
  for (const evidence of item.evidence) {
    assert.match(evidence.url, /^https:\/\//);
    if (evidence.sha256) assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  }
  for (const path of item.locations) assert.ok(await stat(new URL(path, root)));
  for (const adapter of item.adapters) coveredAdapters.add(adapter);
  for (const file of item.bundled_files || []) {
    assert.ok(file.license && file.revision);
    assert.match(file.source_url, /^https:\/\//);
    assert.equal(
      digest(await read(file.path)),
      file.sha256,
      `Changed copied source: ${file.path}`,
    );
    copiedFiles++;
  }
}
const internal = new Set([
  "hdl",
  "model",
  "program",
  "document",
  "waveform",
  "compare",
  "command",
]);
for (const contract of integrationContracts)
  assert.ok(
    internal.has(contract.adapter) || coveredAdapters.has(contract.adapter),
    `Unreviewed adapter: ${contract.adapter}`,
  );
for (const path of [
  "extensions/hdl-debug/iverilog",
  "extensions/hdl-debug/ghdl",
])
  for (const file of (await files(path)).filter((p) =>
    /\.(?:py|c|cc|h|ads|adb|inc)$/.test(p),
  ))
    assert.match(
      (await read(file)).toString().slice(0, 500),
      /SPDX-License-Identifier: GPL-2\.0-or-later/,
    );
for (const file of [
  "scripts/design-klayout.py",
  "scripts/test-design-reports.py",
])
  assert.match(
    (await read(file)).toString().slice(0, 500),
    /SPDX-License-Identifier: MIT/,
  );
assert.equal(pkg.license, "MIT");
assert.equal(lock.packages[""].license, pkg.license);
assert.ok(
  !Object.keys(pkg.dependencies || {}).length,
  "Review new runtime dependencies",
);
for (const name of Object.keys(pkg.devDependencies || {}))
  assert.ok(
    componentIds.has(name),
    `Unreviewed npm development dependency: ${name}`,
  );
for (const file of [
  "LICENSE",
  "ACKNOWLEDGMENTS.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/LICENSING.md",
  "LICENSES/CC0-1.0.txt",
  "LICENSES/CC-BY-ND-4.0.txt",
  "extensions/hdl-debug/COPYING",
  "extensions/hdl-debug/NOTICE",
])
  assert.ok((await read(file)).length > 100, `Missing notice/license: ${file}`);
assert.match((await read("LICENSE")).toString(), /^MIT License\n/);
assert.match(
  (await read("scripts/build-hdl-debug.sh")).toString(),
  /chipsim-observers-NOTICE/,
);
for (const finding of findings.findings) {
  assert.ok(["open", "resolved"].includes(finding.status));
  assert.ok(finding.reason && finding.evidence.length);
  for (const path of finding.evidence) assert.ok((await read(path)).length);
  if (finding.status === "resolved")
    assert.ok(finding.resolution && finding.resolution_evidence?.length);
}
const unresolvedDocs = documents.documents.filter(
  (doc) => doc.distributed !== false && doc.redistribution !== "cleared",
);
const openFindings = findings.findings.filter(
  (finding) => finding.status !== "resolved",
);
console.log(
  `Licensing inventory verified: ${software.components.length} components, ${reviewedPDFs.size} external reference catalog entries, ${copiedFiles} pinned copied sources, observer notices and adapter coverage. Present private PDF fingerprints were checked; absent PDFs are not source-verified.`,
);
console.log(
  `Publication review: ${unresolvedDocs.length} document decisions and ${openFindings.length} release findings remain unresolved. Inventory success is not legal clearance.`,
);
if (args[0] === "--release" && (unresolvedDocs.length || openFindings.length)) {
  for (const finding of openFindings)
    console.error(`OPEN ${finding.id}: ${finding.reason}`);
  process.exitCode = 1;
}
