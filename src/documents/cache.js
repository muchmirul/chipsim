// Bump when extraction starts retaining new source data. Older workspaces
// refresh on demand from their original PDF, never on every startup.
export const EXTRACTION_VERSION = 1;

export function needsDocumentRefresh(document) {
  return document.extractionVersion !== EXTRACTION_VERSION;
}

export function replaceExtraction(existing, extracted) {
  if (
    !/^[a-f\d]{64}$/.test(existing.sha256) ||
    extracted.sha256 !== existing.sha256
  )
    throw new Error(
      "Saved PDF fingerprint changed. Restore the original PDF or import the different document separately; the saved source and experiment were preserved.",
    );
  // Only identity and user-facing naming survive. In particular, old scan
  // limits, geometry and analysis must not shadow the fresh extraction.
  return {
    ...extracted,
    id: existing.id,
    filename: existing.filename,
    createdAt: existing.createdAt,
  };
}
