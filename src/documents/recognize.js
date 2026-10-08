import manifest from "../../docs/references/manifest.json" with { type: "json" };

export function recognizeDocument(document) {
  const exact = manifest.documents.find(
    (source) => source.sha256 === document.sha256,
  );
  if (exact)
    return {
      modelId: exact.chips[0],
      method: "exact document fingerprint",
      title: exact.title,
    };
  const text = document.pages
    .slice(0, 20)
    .map((page) => page.text)
    .join("\n");
  const rules = [
    ["pio", /\bRP2040\b/i, /\bPIO\b|programmable I\/O/i],
    ["pru", /\bAM335[x0-9]\b|\bAMIC110\b/i, /\bPRU\b/i],
    ["flexio", /\bFlexIO\b/i, /\bS32K\w*\b|\bAN12174\b/i],
    ["udb", /PSoC\s*5LP/i, /universal digital|\bUDB/i],
    ["xmos", /\bXS3\b|\bAN03001\b/i, /\bXMOS\b|\bXCORE\b/i],
    ["etpu", /\beTPU\b/i, /Freescale|NXP|AN2933|AN2353/i],
  ];
  const rule = rules.find(
    ([, chip, mechanism]) => chip.test(text) && mechanism.test(text),
  );
  return rule
    ? {
        modelId: rule[0],
        method: "document content match",
        title: document.title,
      }
    : null;
}

// An authored model is the executable interpretation of a manual. The PDF
// fingerprint lets subsequent uploads reopen that interpretation directly.
export function modelsForDocument(document, models) {
  const linked = models.filter((model) =>
    model.sources.some((source) => source.sha256 === document.sha256),
  );
  const recognized = recognizeDocument(document);
  if (recognized && !linked.some((model) => model.id === recognized.modelId)) {
    const builtin = models.find((model) => model.id === recognized.modelId);
    if (builtin) linked.push(builtin);
  }
  return linked;
}

export function searchDocument(document, query, limit = 50) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return document.pages
    .flatMap((page) => {
      const text = page.text.toLowerCase();
      if (!terms.every((term) => text.includes(term))) return [];
      const position = text.indexOf(terms[0]),
        start = Math.max(0, position - 100);
      return [
        { page: page.number, excerpt: page.text.slice(start, position + 400) },
      ];
    })
    .slice(0, limit);
}

export function sourceBundle(documents) {
  return {
    format: "chipsim-source-bundle",
    version: 1,
    createdAt: new Date().toISOString(),
    documents: documents.map(({ bytes, filePath, ...document }) => document),
    instructions:
      "Use AGENTS.md and docs/MODEL_FORMAT.md to build a sourced behavioral model. Preserve PDF page numbers and SHA-256. Import the resulting model JSON into ChipSim; do not assume that a datasheet specifies every internal behavior.",
  };
}
