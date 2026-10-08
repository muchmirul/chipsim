import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, resolve } from "node:path";
const run = promisify(execFile);
export async function extractPDFFile(input, { onProgress = () => {} } = {}) {
  const path = resolve(input),
    bytes = await readFile(path);
  if (bytes.length > 80 * 1024 * 1024) throw new Error("PDF exceeds 80 MiB.");
  if (bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("Expected a PDF datasheet or manual.");
  onProgress("Reading PDF metadata…");
  let info, text;
  try {
    ({ stdout: info } = await run("pdfinfo", [path], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    }));
    onProgress("Extracting searchable text…");
    ({ stdout: text } = await run("pdftotext", ["-enc", "UTF-8", path, "-"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    }));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "Install Poppler (pdfinfo and pdftotext) to import PDFs in the TUI.",
      );
    throw new Error(
      "PDF extraction failed: " + (error.stderr?.trim() || error.message),
    );
  }
  const pageCount = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20000)
    throw new Error("PDF must contain 1–20000 pages.");
  const parts = text.split("\f");
  if (!parts.some((p) => p.trim().length > 30))
    throw new Error(
      "This PDF has no searchable text. OCR it before importing.",
    );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    id: sha256.slice(0, 24),
    filename: basename(path),
    title: basename(path, ".pdf"),
    sha256,
    size: bytes.length,
    pageCount,
    pages: Array.from({ length: pageCount }, (_, index) => ({
      number: index + 1,
      text: (parts[index] || "").trim(),
    })),
    filePath: path,
    createdAt: new Date().toISOString(),
  };
}
