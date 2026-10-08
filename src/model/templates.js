import { counter } from "./builders/counter.js";
import { fifo } from "./builders/fifo.js";
import { shifter } from "./builders/shifter.js";
import { validateModel } from "./validate.js";
import { runChecks } from "./engine.js";
export const templates = [
  {
    id: "counter",
    label: "Counter / timer",
    description: "Enable, reset, count direction, compare, and output toggle.",
  },
  {
    id: "fifo",
    label: "FIFO",
    description:
      "Stored words, read/write pointers, occupancy, overflow, and underflow.",
  },
  {
    id: "shifter",
    label: "Shift transfer",
    description:
      "Serial bits, clock phases, start/reset, and receiver decoding.",
  },
];
const builders = { counter, fifo, shifter };
const keywords = {
  counter: /\btimers?\b|\bcounters?\b/i,
  fifo: /\bFIFO\b|first[- ]in.?first[- ]out/i,
  shifter: /\bshifters?\b|shift registers?/i,
};
const normalized = (text) => text.replace(/\s+/g, " ").trim();
export function suggestScenarios(document) {
  const suggestions = [];
  for (const template of templates) {
    const candidates = [];
    for (const page of document.pages) {
      const text = normalized(page.text);
      const match = keywords[template.id].exec(text);
      if (!match) continue;
      const start = Math.max(0, match.index - 90),
        end = Math.min(text.length, match.index + 360),
        quote = text.slice(start, end);
      const widthPattern =
        template.id === "counter"
          ? /(\d+)[- ]bit (?:timers?|counters?)/i
          : template.id === "shifter"
            ? /(\d+)[- ]bit (?:shifters?|shift registers?)/i
            : /(\d+)[- ]bit (?:FIFO|words?)/i;
      const widthMatch = widthPattern.exec(quote),
        width = widthMatch && Number(widthMatch[1]);
      candidates.push({
        kind: template.id,
        page: page.number,
        quote,
        width: width >= 1 && width <= 32 ? width : null,
      });
    }
    candidates.sort(
      (a, b) =>
        Number(Boolean(b.width)) - Number(Boolean(a.width)) || a.page - b.page,
    );
    suggestions.push(...candidates.slice(0, 3));
  }
  return suggestions;
}
export function modelId(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58);
  return /^[a-z]/.test(slug) ? slug : "model-" + slug;
}
export function buildScenario(document, options) {
  if (!document?.sha256 || !Array.isArray(document.pages))
    throw new Error("Select an imported PDF first.");
  const builder = builders[options.kind];
  if (!builder) throw new Error("Choose a supported peripheral scenario.");
  const width = Number(options.width);
  if (!Number.isInteger(width) || width < 1 || width > 32)
    throw new Error("Register or word width must be 1–32 bits.");
  const page = document.pages.find(
    (page) => page.number === Number(options.page),
  );
  if (!page) throw new Error("Choose an existing PDF page.");
  if (typeof options.quote !== "string" || options.quote.trim().length < 8)
    throw new Error("Select a source excerpt of at least 8 characters.");
  if (typeof options.claim !== "string" || !options.claim.trim())
    throw new Error("Describe what the selected source excerpt supports.");
  if (typeof options.name !== "string" || !options.name.trim())
    throw new Error("Give the simulation a name.");
  const behavior = builder({ ...options, width }),
    spec = {
      schemaVersion: 1,
      id: options.id || modelId(options.name),
      name: options.name.trim(),
      fidelity: "behavioral",
      ...behavior,
      sources: [
        {
          id: "manual",
          title: document.title || document.filename,
          filename: document.filename,
          sha256: document.sha256,
        },
      ],
      evidence: [
        {
          id: "manual-excerpt",
          sourceId: "manual",
          page: Number(options.page),
          quote: options.quote.trim(),
          claim: options.claim.trim(),
        },
      ],
      assumptions: [
        "This scenario was configured by a developer from a local PDF. Source quotations verify textual provenance, not the correctness of every selected behavior.",
        "One tick is a normalized model step, not a physical clock cycle.",
        ...behavior.assumptions,
        ...String(options.assumptions || "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      ],
    };
  validateModel(spec, [document]);
  const checks = runChecks(spec);
  const failed = checks.filter((c) => !c.passed);
  if (failed.length)
    throw new Error(failed.map((c) => c.name + ": " + c.error).join("\n"));
  return { spec, checks };
}
