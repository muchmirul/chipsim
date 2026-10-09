import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { extractPDFFile } from "../documents/extract-node.js";
import { sourceBundle } from "../documents/recognize.js";
import { analyzeDocument } from "../model/from-document.js";
import { builtinModels } from "../models/index.js";
import {
  chipsForSource,
  buildProgrammingContext,
  programmingContextMarkdown,
} from "./context.js";
import {
  AgentError,
  createDirectory,
  readBounded,
  readJSON,
  writeJSON,
  jsonText,
} from "./io.js";

export const packageRoot = resolve(import.meta.dirname, "../..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function prepareProject(pdf, output) {
  // Copy first: extraction and the pinned fingerprint refer to the same bytes.
  const bytes = await readBounded(pdf, 80 * 1048576);
  return createDirectory(output, async (root) => {
    await writeFile(join(root, "manual.pdf"), bytes, { flag: "wx" });
    const document = await extractPDFFile(join(root, "manual.pdf"));
    const analysis = analyzeDocument(document);
    const bundle = jsonText(sourceBundle([document]));
    await writeFile(join(root, "sources.json"), bundle, { flag: "wx" });
    await mkdir(join(root, "pages"));
    for (const page of document.pages)
      await writeFile(
        join(root, "pages", `${String(page.number).padStart(5, "0")}.txt`),
        page.text + "\n",
        { flag: "wx" },
      );
    await mkdir(join(root, "models"));
    const models = [];
    for (const compiled of analysis.models) {
      const file = `models/${compiled.spec.id}.model.json`;
      await writeJSON(join(root, file), compiled.spec);
      models.push({
        id: compiled.spec.id,
        name: compiled.spec.name,
        scope: compiled.spec.scope,
        method: compiled.method,
        file,
        checks: compiled.checks.length,
      });
    }
    await writeJSON(join(root, "analysis.json"), {
      format: "chipsim-document-analysis",
      version: 1,
      models,
      registerTables: analysis.registerTables,
      diagnostics: analysis.diagnostics,
    });
    await mkdir(join(root, "docs"));
    for (const file of [
      "MODEL_FORMAT.md",
      "AGENT_WORKFLOW.md",
      "PROGRAMMING.md",
      "EXISTING_SIMULATORS.md",
    ])
      await copyFile(join(packageRoot, "docs", file), join(root, "docs", file));
    await mkdir(join(root, "examples"));
    await copyFile(
      join(packageRoot, "examples/timer.model.json"),
      join(root, "examples/timer.model.json"),
    );
    await copyFile(
      join(packageRoot, "docs/AGENT_PROJECT.md"),
      join(root, "AGENTS.md"),
    );
    await mkdir(join(root, "programs"));
    const chips = chipsForSource(document.sha256);
    const programming = buildProgrammingContext({
      chips,
      project: root,
      localExamples: true,
      source: {
        sha256: document.sha256,
        pages: document.pageCount,
        path: join(root, "manual.pdf"),
      },
      models: [
        ...analysis.models.map((compiled) => ({
          model: compiled.spec,
          file: join(root, "models", compiled.spec.id + ".model.json"),
          verification:
            "Schema, original source quotes and acceptance cases passed during preparation.",
        })),
        ...builtinModels
          .filter((m) => chips.some((chip) => chip.models.includes(m.id)))
          .map((model) => ({
            model,
            verification:
              "Related built-in teaching scenario; not a compiled native program.",
          })),
      ],
    });
    await writeJSON(join(root, "programming-context.json"), programming);
    await writeFile(
      join(root, "PROGRAMMING_CONTEXT.md"),
      programmingContextMarkdown(programming),
      { flag: "wx" },
    );
    for (const example of programming.examples)
      await copyFile(example.source, example.path);
    const manifest = {
      format: "chipsim-agent-project",
      version: 1,
      source: {
        sha256: document.sha256,
        pages: document.pageCount,
        originalPath: resolve(pdf),
      },
      bundleSha256: digest(bundle),
    };
    // The manifest is written last; interrupted preparation cannot look ready.
    await writeJSON(join(root, "chipsim.project.json"), manifest);
    return {
      project: root,
      source: manifest.source,
      models,
      registerTables: analysis.registerTables.length,
      diagnostics: analysis.diagnostics.length,
      analysis: join(root, "analysis.json"),
      instructions: join(root, "AGENTS.md"),
      programmingContext: {
        json: join(root, "programming-context.json"),
        instructions: join(root, "PROGRAMMING_CONTEXT.md"),
        refresh: ["chipsim", "agent", "context", root],
      },
      next: models.length
        ? "Read PROGRAMMING_CONTEXT.md, select a model and programming format, then use model/program check and run."
        : "Read relevant pages and author a bounded model; no executable behavior was inferred.",
    };
  });
}

export async function loadProject(directory, { fresh = false } = {}) {
  const root = resolve(directory);
  const manifest = await readJSON(join(root, "chipsim.project.json"), 65536);
  if (
    manifest?.format !== "chipsim-agent-project" ||
    manifest.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.source?.sha256 || "") ||
    !/^[a-f0-9]{64}$/.test(manifest.bundleSha256 || "") ||
    !Number.isInteger(manifest.source.pages) ||
    manifest.source.pages < 1 ||
    manifest.source.pages > 20000
  )
    throw new AgentError("PROJECT", "Invalid ChipSim agent project manifest");
  const pdf = join(root, "manual.pdf");
  const bytes = await readBounded(pdf, 80 * 1048576);
  if (digest(bytes) !== manifest.source.sha256)
    throw new AgentError(
      "SOURCE_CHANGED",
      "Saved PDF fingerprint changed; prepare a new project from the intended manual.",
    );
  if (fresh) {
    // Extract exactly the verified bytes, even if another process later edits
    // the project PDF while Poppler is running. Never trust editable page text.
    const temporary = await mkdtemp(join(tmpdir(), "chipsim-source-"));
    try {
      const snapshot = join(temporary, "manual.pdf");
      await writeFile(snapshot, bytes, { flag: "wx", mode: 0o600 });
      const document = await extractPDFFile(snapshot);
      if (document.pageCount !== manifest.source.pages)
        throw new AgentError(
          "PROJECT",
          "Manifest page count does not match the PDF",
        );
      return { root, document: { ...document, filePath: pdf } };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const cached = await readBounded(join(root, "sources.json"), 160 * 1048576);
  if (digest(cached) !== manifest.bundleSha256)
    throw new AgentError(
      "CACHE_CHANGED",
      "Extracted source cache changed; prepare a new project. Do not edit source evidence.",
    );
  const bundle = JSON.parse(cached.toString("utf8")),
    document = bundle?.documents?.[0];
  if (
    bundle?.format !== "chipsim-source-bundle" ||
    bundle.version !== 1 ||
    !Array.isArray(bundle.documents) ||
    bundle.documents.length !== 1 ||
    document?.sha256 !== manifest.source.sha256 ||
    document.pageCount !== manifest.source.pages ||
    !Array.isArray(document.pages) ||
    document.pages.length !== document.pageCount ||
    document.pages.some(
      (page, index) =>
        page?.number !== index + 1 || typeof page.text !== "string",
    )
  )
    throw new AgentError("PROJECT", "Invalid extracted source cache");
  return { root, document };
}

export async function searchProject(
  directory,
  query,
  { offset = 0, limit = 10 } = {},
) {
  if (!query.trim() || query.length > 200)
    throw new AgentError(
      "ARGUMENT",
      "Search query must contain 1–200 characters",
      [],
      2,
    );
  const { document } = await loadProject(directory);
  const terms = query.trim().toLowerCase().split(/\s+/);
  const matches = document.pages.filter((page) =>
    terms.every((term) => page.text.toLowerCase().includes(term)),
  );
  return {
    query,
    sha256: document.sha256,
    total: matches.length,
    offset,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    matches: matches.slice(offset, offset + limit).map((page) => {
      const start = Math.max(
        0,
        page.text.toLowerCase().indexOf(terms[0]) - 100,
      );
      return {
        page: page.number,
        offset: start,
        excerpt: page.text.slice(start, start + 600),
      };
    }),
  };
}

export async function readPage(
  directory,
  number,
  { offset = 0, limit = 8000 } = {},
) {
  const { document } = await loadProject(directory);
  const page = document.pages.find((page) => page.number === number);
  if (!page)
    throw new AgentError(
      "PAGE",
      `PDF page must be between 1 and ${document.pageCount}`,
    );
  return {
    sha256: document.sha256,
    page: number,
    offset,
    total: page.text.length,
    nextOffset: offset + limit < page.text.length ? offset + limit : null,
    text: page.text.slice(offset, offset + limit),
  };
}
