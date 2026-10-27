import { basename, resolve } from "node:path";
import { readBounded } from "../agent/io.js";
import { digest } from "../hdl/io.js";
import { EXTRACTION_VERSION } from "./cache.js";
import { extractPDFFile } from "./extract-node.js";

// CSV sources are authored tables, with one logical source page. They never
// acquire PDF geometry, vendor recognition or automatic datasheet compilation.
export async function extractSourceFile(input, options = {}) {
  if (!/\.csv$/i.test(input)) return extractPDFFile(input, options);
  const filePath = resolve(input),
    bytes = await readBounded(filePath, 65536);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new Error(
      "CSV source must contain readable UTF-8 text without control characters.",
    );
  const sha256 = digest(bytes);
  return {
    extractionVersion: EXTRACTION_VERSION,
    mediaType: "text/csv",
    id: sha256.slice(0, 24),
    filename: basename(filePath),
    title: basename(filePath),
    sha256,
    size: bytes.length,
    pageCount: 1,
    pages: [{ number: 1, text: text.replace(/^\uFEFF/, "").trim() }],
    filePath,
    createdAt: new Date().toISOString(),
  };
}
