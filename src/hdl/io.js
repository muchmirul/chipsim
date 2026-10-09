import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readBounded, readJSON } from "../agent/io.js";
import { parseVCD, validateWaveform, limits } from "./vcd.js";

export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export async function readWaveform(path) {
  const bytes = await readBounded(path, limits.bytes);
  if (/\.vcd$/i.test(path))
    return parseVCD(bytes.toString("utf8"), {
      name: basename(path),
      sha256: digest(bytes),
    });
  return validateWaveform(JSON.parse(bytes.toString("utf8")));
}

export async function readComparisonTrace(path) {
  if (/\.vcd$/i.test(path)) return readWaveform(path);
  const data = await readJSON(path, limits.bytes);
  if (data.format === "chipsim-waveform-session")
    return validateWaveform(data.waveform);
  return data;
}
