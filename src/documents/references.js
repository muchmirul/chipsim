import { resolve } from "node:path";
import { existsSync } from "node:fs";

export const installedRoot = resolve(import.meta.dirname, "../..");

// Catalog paths are metadata. Original vendor documents are private inputs,
// supplied explicitly by the user; no command downloads them automatically.
export function referencePath(source, { root = installedRoot } = {}) {
  const path = typeof source === "string" ? source : source.path;
  if (
    typeof path !== "string" ||
    !/^docs\/references\/[A-Za-z0-9._/-]+\.pdf$/.test(path) ||
    path.split("/").includes("..")
  )
    throw new Error("Invalid catalog reference path.");
  const base =
    resolve(root) === installedRoot
      ? process.env.CHIPSIM_REFERENCE_ROOT || root
      : root;
  return resolve(base, path);
}

export function referenceAvailable(source, options) {
  return existsSync(referencePath(source, options));
}
