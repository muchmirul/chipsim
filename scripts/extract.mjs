#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { sourceBundle } from "../src/documents/recognize.js";
const [input, output] = process.argv.slice(2);
if (!input) {
  console.error(
    "Usage: npm run extract -- manual.pdf [manual.sources.json]\nRequires Poppler: pdfinfo and pdftotext.",
  );
  process.exit(1);
}
try {
  const document = await extractPDFFile(input);
  const target = output || input.replace(/\.pdf$/i, "") + ".sources.json";
  await writeFile(
    target,
    JSON.stringify(sourceBundle([document]), null, 2) + "\n",
  );
  console.log(`Extracted ${document.pageCount} PDF pages to ${target}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
