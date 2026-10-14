import test from "node:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../docs/references/manifest.json" with { type: "json" };
import { extractPDFFile } from "../src/documents/extract-node.js";

const root = resolve(import.meta.dirname, "..");
const fixturePaths = new Set(
  manifest.documents.map((source) => resolve(root, source.path)),
);
export const referencesAvailable = [...fixturePaths].every((path) =>
  existsSync(path),
);

// Public checkouts have catalog metadata, not publisher document bytes. Tests
// with their own original/synthetic PDF fixtures continue to run normally.
export function extractReferencePDF(path, ...args) {
  if (fixturePaths.has(resolve(path)) && !existsSync(path))
    return Promise.resolve(null);
  return extractPDFFile(path, ...args);
}

export function referenceTest(sourceFreeNames = []) {
  const sourceFree = new Set(sourceFreeNames);
  return (name, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const needsPrivateReference = !sourceFree.has(name);
    return test(
      name,
      {
        ...options,
        ...(!referencesAvailable && needsPrivateReference
          ? {
              skip: "Private vendor reference fixtures unavailable; run npm run test:references with CHIPSIM_REFERENCE_ROOT.",
            }
          : {}),
      },
      callback,
    );
  };
}
