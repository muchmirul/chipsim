import { hasTableLayout, hasRegisterTable, popplerLines } from "./layout.js";
import { recognizeDocument } from "./recognize.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, resolve } from "node:path";
import { documentTitle } from "./title.js";
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
  const document = {
    id: sha256.slice(0, 24),
    filename: basename(path),
    title: documentTitle(
      {
        Subject: /^Subject:[ \t]*(.*)$/m.exec(info)?.[1],
        Title: /^Title:[ \t]*(.*)$/m.exec(info)?.[1],
      },
      basename(path),
    ),
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
  const recognized = recognizeDocument(document);
  const scanFunctions =
    !recognized ||
    !["pio", "pru", "flexio", "udb", "xmos", "etpu"].includes(
      recognized.modelId,
    );
  const functionPages = scanFunctions
    ? document.pages.filter((page) => hasTableLayout(page.text))
    : [];
  const registerPages = document.pages.filter((page) =>
    hasRegisterTable(page.text),
  );
  const candidates = [
    ...new Set([...functionPages.slice(0, 32), ...registerPages.slice(0, 32)]),
  ];
  for (const page of candidates) {
    onProgress("Reading table layout on PDF page " + page.number + "…");
    try {
      const { stdout: xml } = await run(
        "pdftotext",
        [
          "-f",
          String(page.number),
          "-l",
          String(page.number),
          "-bbox-layout",
          "-enc",
          "UTF-8",
          path,
          "-",
        ],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      );
      page.layoutLines = popplerLines(xml);
    } catch (error) {
      page.layoutError = "Table geometry unavailable: " + error.message;
    }
  }
  if (functionPages.length > 32) document.tableScanLimit = 32;
  if (registerPages.length > 32) document.registerScanLimit = 32;
  return document;
}
