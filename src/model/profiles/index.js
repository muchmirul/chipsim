import manifest from "../../../docs/references/manifest.json" with { type: "json" };
import { hc595 } from "./hc595.js";
import { pca9555 } from "./pca9555.js";
import { tca9534 } from "./tca9534.js";
import { validateModel } from "../validate.js";
import { runChecks } from "../engine.js";

export const documentProfiles = [
  {
    id: "hc595",
    name: "Nexperia 74HC595 / 74HCT595 · Rev. 12",
    source: manifest.documents.find((source) => source.chips.includes("hc595")),
    build: hc595,
  },
  {
    id: "pca9555",
    name: "TI PCA9555 · SCPS131J",
    source: manifest.documents.find((source) =>
      source.chips.includes("pca9555"),
    ),
    build: pca9555,
  },
  {
    id: "tca9534",
    name: "TI TCA9534 · SCPS197D",
    source: manifest.documents.find((source) =>
      source.chips.includes("tca9534"),
    ),
    build: tca9534,
  },
];

// Matching is byte-exact. A filename, chip name, or excerpt alone never
// authorizes interpreting an unreviewed datasheet as a known device.
export function profileForDocument(document) {
  return (
    documentProfiles.find(
      (profile) => profile.source.sha256 === document.sha256,
    ) || null
  );
}
export function compileDocument(document, { reservedIds = [] } = {}) {
  const profile = profileForDocument(document);
  if (!profile) return null;
  const spec = profile.build(profile.source);
  const reserved = new Set(reservedIds);
  if (reserved.has(spec.id)) {
    const base = spec.id.slice(0, 44) + "-" + document.sha256.slice(0, 8);
    spec.id = base;
    for (let suffix = 2; reserved.has(spec.id); suffix++)
      spec.id = base + "-" + suffix;
  }
  validateModel(spec, [document]);
  const checks = runChecks(spec),
    failed = checks.filter((check) => !check.passed);
  if (failed.length)
    throw new Error(
      "Reviewed profile checks failed: " +
        failed.map((check) => check.name + ": " + check.error).join("; "),
    );
  return {
    spec,
    checks,
    profile: {
      id: profile.id,
      name: profile.name,
      revision: profile.source.revision,
    },
  };
}
