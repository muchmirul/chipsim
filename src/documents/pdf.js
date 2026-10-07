import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/build/pdf.mjs";
import workerSource from "pdfjs-dist/build/pdf.worker.min.mjs";

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
    id: sha256.slice(0, 24),
    sha256,
    filename: file.name,
    title: file.name.replace(/\.pdf$/i, ""),
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
  if (pdf.numPages > 20000) {
    await task.destroy();
    throw new Error("The document exceeds 20000 pages.");
  }
  try {
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
      document.pages.push({ number, text: text.trim() });
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
