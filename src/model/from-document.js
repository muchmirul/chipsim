import { recognizeDocument } from "../documents/recognize.js";
import { compileDocument } from "./profiles/index.js";
import { readFunctionTables } from "./tables/read.js";
import { buildFunctionTable } from "./tables/build.js";
export function analyzeDocument(document, { reservedIds = [] } = {}) {
  const profile = compileDocument(document, { reservedIds });
  if (profile)
    return {
      models: [{ ...profile, method: "reviewed datasheet profile" }],
      diagnostics: [],
    };
  const recognized = recognizeDocument(document);
  if (
    recognized &&
    ["pio", "pru", "flexio", "udb", "xmos", "etpu"].includes(recognized.modelId)
  )
    return { models: [], diagnostics: [] };
  const { tables, diagnostics } = readFunctionTables(document),
    models = [],
    reserved = [...reservedIds];
  for (const table of tables)
    try {
      const compiled = buildFunctionTable(document, table, {
        reservedIds: reserved,
      });
      models.push(compiled);
      reserved.push(compiled.spec.id);
    } catch (error) {
      diagnostics.push({
        page: table.page,
        caption: table.caption,
        reason: error.message,
      });
    }
  if (document.tableScanLimit)
    diagnostics.push({
      reason:
        "Table geometry scan was limited to " +
        document.tableScanLimit +
        " pages.",
    });
  return { models, diagnostics };
}
