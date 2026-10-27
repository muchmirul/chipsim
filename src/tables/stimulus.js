import { readCSV } from "./csv.js";
import { parsePayload } from "../core/values.js";
import { validateInputs } from "../model/stimulus.js";
import { readBounded, readJSON } from "../agent/io.js";

export function readStimulusCSV(text, signals) {
  const events = readCSV(text, ["tick", "signal", "value"]).map(
    (row, index) => {
      const tick = parsePayload(row.tick)?.value;
      const value = parsePayload(row.value)?.value;
      if (tick === undefined || value === undefined)
        throw new Error(
          `CSV stimulus row ${index + 1}: tick/value must be unsigned decimal, 0x, 0b or 0o integers.`,
        );
      return { tick, signal: row.signal, value };
    },
  );
  // Preserve the ordinary event ordering, including same-pin/tick overrides.
  return validateInputs(signals, events);
}

export async function readInputFile(file, signals) {
  if (!/\.csv$/i.test(file)) return readJSON(file);
  const bytes = await readBounded(file, 1048576);
  return readStimulusCSV(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    signals,
  );
}
