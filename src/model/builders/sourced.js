import { validateModel } from "../validate.js";
import { runChecks } from "../engine.js";
import { scenarioAssumptions } from "./assumptions.js";

export function modelId(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58);
  return /^[a-z]/.test(slug) && !["constructor", "prototype"].includes(slug)
    ? slug
    : "model-" + slug.slice(0, 52);
}

// Shared provenance/check gate for developer-authored builders. A quotation
// proves textual provenance; the selected rules remain explicit assumptions.
export function sourcedModel(document, options, behavior) {
  if (!document?.sha256 || !Array.isArray(document.pages))
    throw new Error("Select an imported PDF first.");
  if (!document.pages.some((page) => page.number === Number(options.page)))
    throw new Error("Choose an existing PDF page.");
  if (typeof options.quote !== "string" || options.quote.trim().length < 8)
    throw new Error("Select a source excerpt of at least 8 characters.");
  if (typeof options.claim !== "string" || !options.claim.trim())
    throw new Error("Describe what the selected source excerpt supports.");
  if (typeof options.name !== "string" || !options.name.trim())
    throw new Error("Give the simulation a name.");
  const spec = {
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
    assumptions: scenarioAssumptions(behavior.assumptions, options.assumptions),
  };
  validateModel(spec, [document]);
  const checks = runChecks(spec),
    failed = checks.filter((check) => !check.passed);
  if (failed.length)
    throw new Error(
      failed.map((check) => check.name + ": " + check.error).join("\n"),
    );
  return { spec, checks };
}
