import { readRegisterTables } from "./register-tables/read.js";
import { recognizeDocument } from "../documents/recognize.js";
import { compileDocument } from "./profiles/index.js";
import { readFunctionTables } from "./tables/read.js";
import { buildFunctionTable } from "./tables/build.js";
import { buildSequentialTable } from "./tables/sequential-build.js";
import { buildRetainedTable } from "./tables/retained-build.js";
export function analyzeDocument(document, { reservedIds = [] } = {}) {
  const registerInventory = readRegisterTables(document);
  const registerTables = registerInventory.tables;
  const profile = compileDocument(document, { reservedIds });
  if (profile)
    return {
      models: [{ ...profile, method: "reviewed datasheet profile" }],
      registerTables,
      diagnostics: registerInventory.diagnostics,
    };
  const recognized = recognizeDocument(document);
  if (
    recognized &&
    ["pio", "pru", "flexio", "udb", "xmos", "etpu"].includes(recognized.modelId)
  )
    return {
      models: [],
      registerTables,
      diagnostics: registerInventory.diagnostics,
    };
  const { tables, diagnostics } = readFunctionTables(document),
    models = [],
    reserved = [...reservedIds];
  diagnostics.push(...registerInventory.diagnostics);
  for (const table of tables)
    try {
      const compiled = (
        table.kind === "sequential"
          ? buildSequentialTable
          : table.kind === "retained"
            ? buildRetainedTable
            : buildFunctionTable
      )(document, table, {
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
  return { models, registerTables, diagnostics };
}
