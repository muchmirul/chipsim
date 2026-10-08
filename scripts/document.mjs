#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { analyzeDocument } from "../src/model/from-document.js";
const args = process.argv.slice(2),
  file = args[0];
if (!file || ["--help", "-h"].includes(file)) {
  console.log(
    "Usage: npm run document -- manual.pdf [--out model.json] [--json]\nAnalyze a local PDF using reviewed profiles and complete binary or supported edge-triggered function tables. --out requires exactly one generated model.",
  );
  process.exit(0);
}
try {
  let output = null,
    json = false;
  for (let index = 1; index < args.length; index++) {
    if (args[index] === "--json") json = true;
    else if (args[index] === "--out" && args[index + 1]) output = args[++index];
    else throw new Error("Unknown or incomplete option " + args[index]);
  }
  const document = await extractPDFFile(file),
    analysis = analyzeDocument(document);
  if (output) {
    if (analysis.models.length !== 1)
      throw new Error(
        "--out needs exactly one compilable model; found " +
          analysis.models.length +
          ". Use --json to inspect all results.",
      );
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify(analysis.models[0].spec, null, 2) + "\n",
    );
  }
  if (json)
    console.log(
      JSON.stringify(
        {
          format: "chipsim-document-analysis",
          version: 1,
          source: {
            sha256: document.sha256,
            filename: document.filename,
            pages: document.pageCount,
          },
          models: analysis.models.map((model) => ({
            method: model.method,
            spec: model.spec,
            checks: model.checks,
          })),
          diagnostics: analysis.diagnostics,
        },
        null,
        2,
      ),
    );
  else {
    console.log(
      document.filename + " · " + analysis.models.length + " compiled model(s)",
    );
    for (const model of analysis.models)
      console.log(
        model.spec.id +
          " · " +
          model.method +
          " · " +
          model.checks.length +
          " checks passed",
      );
    for (const issue of analysis.diagnostics)
      console.log("PDF page " + (issue.page || "?") + ": " + issue.reason);
    if (!analysis.models.length)
      console.log(
        "No executable interpretation was created. Inspect sources or use the local scenario builder.",
      );
    if (output) console.log("Saved " + resolve(output));
  }
} catch (error) {
  console.error("ChipSim document: " + error.message);
  process.exitCode = 1;
}
