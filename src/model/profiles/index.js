import manifest from "../../../docs/references/manifest.json" with { type: "json" };
import { hc595 } from "./hc595.js";
import { pca9555 } from "./pca9555.js";
import { tca9534 } from "./tca9534.js";
import { esp32c6Pcnt } from "./esp32c6-pcnt.js";
import { esp32c6Gpio } from "./esp32c6-gpio.js";
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
  {
    id: "esp32c6-pcnt",
    name: "Espressif ESP32-C6 PCNT channel 0 · TRM v1.2",
    source: manifest.documents.find((source) =>
      source.chips.includes("esp32c6-pcnt"),
    ),
    build: esp32c6Pcnt,
  },
  {
    id: "esp32c6-gpio",
    name: "Espressif ESP32-C6 GPIO output registers · TRM v1.2",
    source: manifest.documents.find((source) =>
      source.chips.includes("esp32c6-gpio"),
    ),
    build: esp32c6Gpio,
  },
];

// Matching is byte-exact. A filename, chip name, or excerpt alone never
// authorizes interpreting an unreviewed datasheet as a known device.
export function profilesForDocument(document) {
  return documentProfiles.filter(
    (profile) => profile.source.sha256 === document.sha256,
  );
}
export function profileForDocument(document, { profileId } = {}) {
  const matches = profilesForDocument(document).filter(
    (profile) => !profileId || profile.id === profileId,
  );
  if (matches.length > 1)
    throw new Error(
      "This PDF supports multiple reviewed profiles; choose profileId or use compileDocumentProfiles().",
    );
  return matches[0] || null;
}
function compileProfile(document, profile, reservedIds) {
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
export function compileDocument(
  document,
  { reservedIds = [], profileId } = {},
) {
  return compileProfile(
    document,
    profileForDocument(document, { profileId }),
    reservedIds,
  );
}
export function compileDocumentProfiles(document, { reservedIds = [] } = {}) {
  const reserved = [...reservedIds];
  return profilesForDocument(document).map((profile) => {
    const result = compileProfile(document, profile, reserved);
    reserved.push(result.spec.id);
    return result;
  });
}
