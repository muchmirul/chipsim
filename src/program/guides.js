import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readBounded } from "../agent/io.js";
import { ProgramError } from "./parse.js";
import manifest from "../../docs/references/manifest.json" with { type: "json" };
import catalog from "../../docs/references/catalog.json" with { type: "json" };

export const packageRoot = resolve(import.meta.dirname, "../..");
const normalize = (text) => text.replace(/\s+/g, " ").trim();

export async function verifyProgramGuides(
  program,
  model,
  { root = packageRoot, manual = null, required = true } = {},
) {
  if (required && !program.guides.length)
    throw new ProgramError(
      1,
      'Declare a programming guide: guide DOCUMENT_ID PDF_PAGE "exact quote". See docs/references/catalog.json.',
    );
  const results = [],
    files = new Map();
  const temporary = await mkdtemp(join(tmpdir(), "chipsim-guides-"));
  try {
    for (const reference of program.guides) {
      let document, path;
      if (reference.document === "manual" && manual) {
        if (!model.sources.some((s) => s.sha256 === manual.sha256))
          throw new ProgramError(
            reference.line,
            "The selected manual does not belong to this model.",
          );
        document = {
          title: manual.title,
          sha256: manual.sha256,
          pages: manual.pageCount,
          id: "manual",
        };
        path = manual.filePath;
      } else {
        document = manifest.documents.find((d) => d.id === reference.document);
        const applicable = catalog.chips.some(
          (chip) =>
            chip.documents.programmingGuide.includes(reference.document) &&
            (chip.models.includes(model.id) ||
              Object.values(chip.documents)
                .flat()
                .some((id) =>
                  model.sources.some(
                    (source) =>
                      source.sha256 ===
                      manifest.documents.find((d) => d.id === id)?.sha256,
                  ),
                )),
        );
        if (!document || !applicable)
          throw new ProgramError(
            reference.line,
            "Unknown or inapplicable programming guide " + reference.document,
          );
        path = resolve(root, document.path);
      }
      if (reference.page > document.pages)
        throw new ProgramError(
          reference.line,
          "Guide page exceeds the PDF's page count.",
        );
      if (!files.has(path)) {
        const bytes = await readBounded(path, 80 * 1048576);
        if (
          createHash("sha256").update(bytes).digest("hex") !== document.sha256
        )
          throw new ProgramError(
            reference.line,
            "Programming guide fingerprint changed: " + path,
          );
        const snapshot = join(temporary, files.size + ".pdf");
        await writeFile(snapshot, bytes);
        files.set(path, snapshot);
      }
      const { stdout } = await promisify(execFile)(
        "pdftotext",
        [
          "-f",
          String(reference.page),
          "-l",
          String(reference.page),
          "-enc",
          "UTF-8",
          files.get(path),
          "-",
        ],
        { encoding: "utf8", timeout: 30000, maxBuffer: 1048576 },
      );
      if (!normalize(stdout).includes(normalize(reference.quote)))
        throw new ProgramError(
          reference.line,
          "Quote does not occur on the actual programming-guide PDF page.",
        );
      results.push({
        ...reference,
        title: document.title,
        sha256: document.sha256,
        path,
        verification: "fingerprinted original PDF page",
        usage:
          reference.document === "manual"
            ? "User-selected programming section in project manual"
            : "Cataloged vendor programming reference",
      });
    }
    return results;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
