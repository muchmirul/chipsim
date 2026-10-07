#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { sourceBundle } from "../src/documents/recognize.js";
const [input, output] = process.argv.slice(2);
if (!input) {
  console.error(
    "Usage: npm run extract -- manual.pdf [manual.sources.json]\nRequires Poppler: pdfinfo and pdftotext.",
  );
  process.exit(1);
}
try {
  const path = resolve(input),
    bytes = await readFile(path);
  if (bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("Expected a PDF file");
  const info = execFileSync("pdfinfo", [path], { encoding: "utf8" }),
    pageCount = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
  const text = execFileSync("pdftotext", ["-enc", "UTF-8", path, "-"], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const parts = text.split("\f");
  if (!parts.some((p) => p.trim().length > 30))
    throw new Error("No searchable text. OCR the PDF first.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const document = {
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
    createdAt: new Date().toISOString(),
  };
  const target = output || input.replace(/\.pdf$/i, "") + ".sources.json";
  await writeFile(
    target,
    JSON.stringify(sourceBundle([document]), null, 2) + "\n",
  );
  console.log(`Extracted ${pageCount} PDF pages to ${target}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
