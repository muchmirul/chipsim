import { positionedLines, hasTableLayout, hasRegisterTable } from "./layout.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/build/pdf.mjs";
import workerSource from "pdfjs-dist/build/pdf.worker.min.mjs";
import { documentTitle } from "./title.js";
import { EXTRACTION_VERSION } from "./cache.js";

GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([workerSource], { type: "text/javascript" }),
);

export async function extractPDF(
  file,
  { onProgress = () => {}, onFirstPages = () => {}, signal } = {},
) {
  if (file.size > 80 * 1024 * 1024)
    throw new Error("The PDF exceeds the 80 MiB document limit.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
    throw new Error("Select a PDF datasheet or reference manual.");
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const document = {
    extractionVersion: EXTRACTION_VERSION,
    id: sha256.slice(0, 24),
    sha256,
    filename: file.name,
    title: documentTitle(null, file.name),
    size: file.size,
    pages: [],
    bytes,
    createdAt: new Date().toISOString(),
  };
  const task = getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
  });
  const pdf = await task.promise;
  document.pageCount = pdf.numPages;
  try {
    const metadata = await pdf.getMetadata();
    document.title = documentTitle(metadata.info, file.name);
  } catch {
    /* Metadata is optional; text and bytes remain authoritative. */
  }
  if (pdf.numPages > 20000) {
    await task.destroy();
    throw new Error("The document exceeds 20000 pages.");
  }
  try {
    let tablePages = 0,
      registerPages = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      if (signal?.aborted)
        throw new DOMException("Document extraction canceled", "AbortError");
      const page = await pdf.getPage(number),
        content = await page.getTextContent();
      let text = "",
        previousY = null;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform?.[5];
        if (previousY !== null && Math.abs(y - previousY) > 3) text += "\n";
        else if (text && !text.endsWith("\n")) text += " ";
        text += item.str;
        previousY = y;
        if (item.hasEOL) text += "\n";
      }
      const extracted = { number, text: text.trim() };
      const functionTable = hasTableLayout(text),
        registerTable = hasRegisterTable(text);
      if (functionTable && ++tablePages > 32) document.tableScanLimit = 32;
      if (registerTable && ++registerPages > 32)
        document.registerScanLimit = 32;
      if (
        (functionTable && tablePages <= 32) ||
        (registerTable && registerPages <= 32)
      )
        extracted.layoutLines = positionedLines(
          content.items
            .filter((item) => "str" in item)
            .map((item) => ({
              text: item.str,
              x: item.transform[4],
              y: -item.transform[5],
              width: item.width,
            })),
        );
      document.pages.push(extracted);
      page.cleanup();
      if (number === Math.min(5, pdf.numPages)) onFirstPages(document);
      onProgress({ completed: number, total: pdf.numPages });
      if (number % 5 === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!document.pages.some((page) => page.text.length > 30))
      throw new Error(
        "This PDF has no extractable text. Supply a searchable PDF or OCR it before importing.",
      );
    return document;
  } finally {
    await task.destroy();
  }
}
