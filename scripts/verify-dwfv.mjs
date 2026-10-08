#!/usr/bin/env node
import {
  compileDocument,
  documentProfiles,
} from "../src/model/profiles/index.js";
import { analyzeDocument } from "../src/model/from-document.js";
import references from "../docs/references/manifest.json" with { type: "json" };
import { extractPDFFile } from "../src/documents/extract-node.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  builtinModels,
  defaultParameters,
  registerModel,
} from "../src/models/index.js";
import { exportVCD } from "../src/trace/export.js";
import { buildScenario } from "../src/model/templates.js";
const viewer = process.argv[2] || process.env.CHIPSIM_DWFV || "dwfv",
  directory = await mkdtemp(join(tmpdir(), "chipsim-dwfv-"));
try {
  const document = {
    sha256: "a".repeat(64),
    filename: "test.pdf",
    pages: [
      {
        number: 1,
        text: "Test reference: a FIFO and a 32-bit shift register.",
      },
    ],
  };
  const models = [
    ...builtinModels,
    ...["fifo", "shifter"].map((kind) =>
      registerModel(
        buildScenario(document, {
          name: kind,
          kind,
          width: 32,
          depth: 16,
          value: 0xffffffff,
          direction: "msb",
          page: 1,
          quote: document.pages[0].text,
          claim: "Test resource declaration.",
        }).spec,
        [document],
      ),
    ),
  ];
  for (const profile of documentProfiles) {
    const document = await extractPDFFile(
      new URL("../" + profile.source.path, import.meta.url).pathname,
    );
    models.push(registerModel(compileDocument(document).spec, [document]));
  }
  for (const source of references.documents.filter(
    (source) => source.compiler === "function-table",
  )) {
    const document = await extractPDFFile(
      new URL("../" + source.path, import.meta.url).pathname,
    );
    models.push(
      ...analyzeDocument(document).models.map((model) =>
        registerModel(model.spec, [document]),
      ),
    );
  }
  for (const model of models) {
    const path = join(directory, model.id + ".vcd");
    await writeFile(
      path,
      exportVCD(model, model.simulate(defaultParameters(model))),
    );
    const stats = execFileSync(viewer, [path, "--stats"], { encoding: "utf8" });
    assert.match(stats, /signals_/);
    console.log(model.id + ": dwfv parsed signals and registers");
  }
  const at = execFileSync(viewer, [join(directory, "pio.vcd"), "--at", "2"], {
    encoding: "utf8",
  });
  assert.match(at, /signals_clock.*h1/);
  assert.match(at, /registers_deadline.*hx/);
  console.log("dwfv cursor values and unknown unarmed registers verified.");
} catch (error) {
  console.error(
    error.code === "ENOENT"
      ? "Install dwfv or supply its executable path."
      : error.message,
  );
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
