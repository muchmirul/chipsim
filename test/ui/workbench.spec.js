import {
  readRegisterTables,
  registerDraftRows,
} from "../../src/model/register-tables/read.js";
import { analyzeDocument } from "../../src/model/from-document.js";
import { documentProfiles } from "../../src/model/profiles/index.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractPDFFile } from "../../src/documents/extract-node.js";
import { buildBehaviorTable } from "../../src/model/behavior-table/build.js";
import { buildRegisterBank } from "../../src/model/register-bank/build.js";
import { EXTRACTION_VERSION } from "../../src/documents/cache.js";
async function ready(page, url = "/") {
  await page.goto(url);
  await expect(page.locator("#model-title")).toHaveText("RP2040 PIO");
}
async function downloaded(page, action) {
  const promise = page.waitForEvent("download");
  await action();
  const file = await promise;
  return readFile(await file.path(), "utf8");
}
async function ageBrowserCache(
  page,
  { badBytes = null, editModel = false } = {},
) {
  await page.evaluate(
    ({ badBytes, editModel }) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("chipsim-workspace", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction(["documents", "models"], "readwrite");
          const documents = tx.objectStore("documents"),
            models = tx.objectStore("models");
          const saved = documents.getAll();
          saved.onsuccess = () => {
            for (const document of saved.result) {
              delete document.extractionVersion;
              for (const page of document.pages) delete page.layoutLines;
              document.tableScanLimit = 32;
              document.registerScanLimit = 32;
              document.analysis = {
                models: [],
                registerTables: [{ id: "fabricated" }],
                diagnostics: [{ reason: "Stale analysis" }],
              };
              if (badBytes === "missing") delete document.bytes;
              else if (badBytes) document.bytes = new Uint8Array(badBytes);
              documents.put(document);
            }
          };
          if (editModel) {
            const savedModels = models.getAll();
            savedModels.onsuccess = () => {
              for (const spec of savedModels.result) {
                spec.name = "My authored GPIO experiment";
                spec.assumptions.push(
                  "An authored assumption refresh must preserve.",
                );
                models.put(spec);
              }
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { badBytes, editModel },
  );
}
function pdfFixture(text) {
  const stream = `BT /F1 12 Tf 40 700 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const position = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, "0") + " 00000 n ")
    .join(
      "\n",
    )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  return Buffer.from(result);
}
test("integer formats, display changes, stepping, compare and filtered trace exports", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  for (const input of ["179", "0xB3", "0b10110011", "0o263"]) {
    await page.locator("#parameter-payload").fill(input);
    await page.locator("#parameter-payload").press("Tab");
    await expect(page.locator("#payload-equivalents")).toContainText(
      "179 = 0xB3",
    );
  }
  await page.locator("#step").click();
  await expect(page.locator("#tick-label")).toHaveText("1 / 59");
  await page.locator("#value-format").selectOption("decimal");
  await expect(page.locator("#tick-label")).toHaveText("1 / 59");
  await expect(page.locator("#parameter-payload")).toHaveValue("179");
  await page.locator("#next-event").click();
  await page.locator("#compare-toggle").check();
  await expect(page.locator(".inspect-card")).toHaveCount(2);
  await page.locator("#tab-trace").click();
  await page.locator("#next-event").click();
  await page.locator("#log-filter").fill("clock");
  await expect(page.locator("#log-count")).toContainText("rows");
  for (const type of ["csv", "json", "vcd"]) {
    await page.locator("#trace-format").selectOption(type);
    const content = await downloaded(page, () =>
      page.locator("#export-trace").click(),
    );
    expect(content).toContain(
      type === "csv"
        ? "signal.data"
        : type === "json"
          ? "chipsim-trace"
          : "$enddefinitions",
    );
  }
  expect(errors).toEqual([]);
});
test("known PDF opens its example, source text persists, and sourced model imports", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/nxp-flexio-an12174.pdf");
  await expect(page.locator("#document-count")).toHaveText("1");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText("NXP FlexIO");
  await page.locator(".document-item").click();
  await page.locator("#document-search").fill("16-bit timers");
  await expect(page.locator(".search-result").first()).toContainText(
    "PDF page 3",
  );
  const bundle = JSON.parse(
    await downloaded(page, () => page.locator("#export-sources").click()),
  );
  expect(bundle.documents[0].pages.length).toBe(46);
  expect(bundle.documents[0].bytes).toBeUndefined();
  await page.locator("#close-document").click();
  await page.locator("#model-file").setInputFiles("examples/timer.model.json");
  await expect(page.locator("#model-title")).toHaveText(
    "Timer counter example",
  );
  await expect(page.locator("#notice")).toContainText(
    "Source evidence verified",
  );
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText(
    "4 acceptance checks passed",
  );
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(
    "Timer counter example",
  );
  await expect(page.locator("#document-count")).toHaveText("1");
  await expect(page.locator("#model-count")).toHaveText("7");
  const spec = JSON.parse(await readFile("examples/timer.model.json", "utf8"));
  spec.evidence[0].quote = "THIS QUOTE IS ABSENT IN THE REFERENCE";
  await page.locator("#model-file").setInputFiles({
    name: "bad.model.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(spec)),
  });
  await expect(page.locator("#notice")).toContainText("quote does not occur");
});
test("TUI-authored behavior-table models remain sourced, portable, and persistent in the optional browser", async ({
  page,
}) => {
  const document = await extractPDFFile(
      resolve("docs/references/nexperia-74hc00.pdf"),
    ),
    { spec } = buildBehaviorTable(document, {
      name: "Entered NAND behavior",
      inputs: "A B",
      outputs: "Y",
      states: "logic",
      rules: await readFile("examples/nand.rules.txt", "utf8"),
      page: 3,
      quote: "Quad 2-input NAND gate",
      claim:
        "The entered rows describe one manually reviewed NAND function from the cited page.",
    });
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/nexperia-74hc00.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await page.locator("#model-file").setInputFiles({
    name: "entered.model.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(spec)),
  });
  await expect(page.locator("#model-title")).toHaveText(spec.name);
  await expect(page.locator("#notice")).toContainText(
    "Source evidence verified",
  );
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText(
    "not inferred from the PDF",
  );
  await expect(page.locator("#source-panel")).toContainText(
    "Developer-entered row 3",
  );
  await page.locator("#seek").fill("3");
  await page.locator("#seek").dispatchEvent("input");
  await expect(
    page.locator(".register-table tr").filter({ hasText: "pin_y" }),
  ).toContainText("0x0");
  await page.locator("#tab-trace").click();
  await page.locator("#trace-format").selectOption("json");
  const trace = JSON.parse(
    await downloaded(page, () => page.locator("#export-trace").click()),
  );
  expect(trace.trace[3].state).toBe("state_logic");
  expect(trace.model.definition.authoring).toEqual(spec.authoring);
  expect(
    trace.trace.slice(1, 5).map((snapshot) => snapshot.signals.pin_y),
  ).toEqual([1, 1, 0, 1]);
  const stale = structuredClone(spec);
  stale.authoring.configuration.rules = "logic XX -> logic / 1";
  await page.locator("#model-file").setInputFiles({
    name: "stale.model.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(stale)),
  });
  await expect(page.locator("#notice")).toContainText(
    "does not match generated",
  );
  await expect(page.locator("#model-title")).toHaveText(spec.name);
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(spec.name);
});

test("unfamiliar PDF opens workspace without claiming a generated simulation", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#document-file").setInputFiles({
    name: "unfamiliar.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(
      "ExampleDevice reference manual. The counter increments when enabled.",
    ),
  });
  await expect(page.locator("#document-dialog")).toBeVisible();
  await expect(page.locator("#document-info")).toContainText(
    "No matching simulation yet",
  );
  await expect(page.locator("#model-count")).toHaveText("6");
  await expect(page.locator("#document-results")).toContainText(
    "counter increments",
  );
});
test("session restores custom model, stimulus and cursor", async ({ page }) => {
  await ready(page);
  await page.locator("#model-file").setInputFiles("examples/timer.model.json");
  await expect(page.locator("#model-title")).toHaveText(
    "Timer counter example",
  );
  await page.locator("#parameter-period").fill("0x03");
  await page.locator("#parameter-period").press("Tab");
  await page.locator("#advanced-controls").click();
  await page
    .locator("#input-events")
    .fill('[{"tick":2,"signal":"enable","value":0}]');
  await page.locator("#apply-events").click();
  await page.locator("#step").click();
  const session = await downloaded(page, () =>
    page.locator("#session-menu").click(),
  );
  await page.locator('[data-model="pio"]').click();
  await page.locator("#session-file").setInputFiles({
    name: "session.json",
    mimeType: "application/json",
    buffer: Buffer.from(session),
  });
  await expect(page.locator("#model-title")).toHaveText(
    "Timer counter example",
  );
  await expect(page.locator("#tick-label")).toHaveText("1 / 40");
  await expect(page.locator("#parameter-period")).toHaveValue("3");
});
test("portable file runs offline and imports a PDF without network requests", async ({
  page,
}) => {
  const external = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) external.push(r.url());
  });
  await ready(page, "file://" + resolve("chipsim.html"));
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/xmos-clocked-io-an03001.pdf");
  await expect(page.locator("#document-count")).toHaveText("1");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText("XMOS xCORE");
  expect(external).toEqual([]);
});
test("mobile viewport keeps controls usable without page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await expect(page.locator("#step")).toBeVisible();
  await page.locator("#step").click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
});

test("uploading a manual opens its installed sourced model after verification", async ({
  page,
}) => {
  const { createHash } = await import("node:crypto");
  const bytes = pdfFixture(
    "ExampleDevice reference manual. The counter increments when enabled.",
  );
  const spec = JSON.parse(await readFile("examples/timer.model.json", "utf8"));
  spec.id = "exampledevice-counter";
  spec.name = "ExampleDevice counter";
  spec.sources[0] = {
    id: "manual",
    filename: "exampledevice.pdf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  spec.evidence[0] = {
    id: "timer-features",
    sourceId: "manual",
    page: 1,
    quote: "The counter increments when enabled.",
    claim: "Counter increments while enabled.",
  };
  await ready(page);
  await page.locator("#model-file").setInputFiles({
    name: "counter.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(spec)),
  });
  await expect(page.locator("#model-title")).toHaveText(spec.name);
  await page.locator('[data-model="pio"]').click();
  await page.locator("#document-file").setInputFiles({
    name: "exampledevice.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText(spec.name);
  await expect(page.locator("#document-dialog")).toBeHidden();
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).not.toContainText(
    "attach exampledevice.pdf",
  );
});

test("an attached manual rejects a previously unverified mismatching model safely", async ({
  page,
}) => {
  const spec = JSON.parse(await readFile("examples/timer.model.json", "utf8"));
  spec.evidence[0].quote =
    "This statement is absent from the actual vendor reference.";
  await ready(page);
  await page.locator("#model-file").setInputFiles({
    name: "bad-source.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(spec)),
  });
  await expect(page.locator("#model-count")).toHaveText("7");
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/nxp-flexio-an12174.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-count")).toHaveText("6");
  await expect(page.locator("#notice")).toContainText(
    "Source verification failed",
  );
  await expect(page.locator("#model-title")).toHaveText("NXP FlexIO");
  await page.locator("#step").click();
  await expect(page.locator("#tick-label")).toHaveText("1 / 59");
});

test("a PDF becomes a counter simulation through the local guided builder", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#document-file").setInputFiles({
    name: "ExampleDevice.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(
      "ExampleDevice reference manual. A 16-bit counter increments when enabled. RESET clears the counter.",
    ),
  });
  await expect(page.locator("#document-dialog")).toBeVisible();
  await page.locator("#document-create-model").click();
  await expect(page.locator("#builder-dialog")).toBeVisible();
  await expect(page.locator("#builder-width")).toHaveValue("16");
  await expect(page.locator("#builder-status")).toContainText(
    "4 acceptance checks passed",
  );
  await page.locator("#builder-name").fill("ExampleDevice timer");
  await page.locator("#builder-value").fill("0x03");
  await page.locator("#builder-run").click();
  await expect(page.locator("#builder-dialog")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText("ExampleDevice timer");
  await expect(page.locator("#model-count")).toHaveText("7");
  await page.locator("#step").click();
  await page.locator("#step").click();
  await page.locator("#step").click();
  await expect(page.locator(".register-table")).toContainText("0x1");
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText(
    "Source quotations verify textual provenance",
  );
  await expect(page.locator("#source-panel")).toContainText("page 1");
  const exported = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  expect(exported.parameters[0].default).toBe(3);
  expect(exported.sources[0].sha256).toHaveLength(64);
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText("ExampleDevice timer");
});

test("builder blocks wrong page evidence and invalid numeric configuration", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#document-file").setInputFiles({
    name: "counter.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(
      "Counter manual. A 16-bit counter can count up or down and has enable and reset controls.",
    ),
  });
  await page.locator("#document-create-model").click();
  await page.locator("#builder-value").fill("not-a-number");
  await expect(page.locator("#builder-run")).toBeDisabled();
  await expect(page.locator("#builder-status")).toContainText(
    "whole default value",
  );
  await page.locator("#builder-value").fill("3");
  await page
    .locator("#builder-quote")
    .fill("A statement not present in this PDF.");
  await expect(page.locator("#builder-run")).toBeDisabled();
  await expect(page.locator("#builder-status")).toContainText(
    "quote does not occur",
  );
});

test("builder FIFO and shift models run their example stimulus offline", async ({
  page,
}) => {
  await ready(page, "file://" + resolve("chipsim.html"));
  await page.locator("#document-file").setInputFiles({
    name: "logic.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(
      "Logic peripheral manual. An 8-bit FIFO stores words. The shifter is an 8-bit shift register.",
    ),
  });
  await page.locator("#document-create-model").click();
  await page.locator("#builder-kind").selectOption("fifo");
  await page.locator("#builder-name").fill("Local FIFO");
  await page.locator("#builder-depth").fill("2");
  await page.locator("#builder-run").click();
  await expect(page.locator("#model-title")).toHaveText("Local FIFO");
  await page.locator("#step").click();
  await page.locator("#step").click();
  await page.locator("#step").click();
  await expect(page.locator(".current-event")).toContainText("overflow");
  await page.locator(".document-item").click();
  await page.locator("#document-create-model").click();
  await page.locator("#builder-kind").selectOption("shifter");
  await page.locator("#builder-name").fill("Local shifter");
  await page.locator("#builder-direction").selectOption("msb");
  await page.locator("#builder-value").fill("0xB3");
  await page.locator("#builder-run").click();
  await expect(page.locator("#model-title")).toHaveText("Local shifter");
  await page.locator("#seek").fill("33");
  await page.locator("#seek").dispatchEvent("input");
  await expect(page.locator(".register-table")).toContainText("0xB3");
});

test("binary-input tri-state PDF compiles locally and preserves released outputs across views, exports and reload", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/ti-sn74lvc1g125.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toContainText("Function Table");
  await expect(page.locator("#model-title")).toContainText("SN74LVC1G125");
  await page.locator("#seek").fill("4");
  await page.locator("#seek").dispatchEvent("input");
  await expect(
    page.locator(".register-table tr").filter({ hasText: "pin_y" }),
  ).toContainText("Z");
  await expect(page.locator(".high-impedance")).toHaveCount(1);
  await expect(page.locator(".wave-svg")).toContainText("high impedance");
  const geometry = await page
    .locator(".wave-svg")
    .evaluate((svg) => svg.outerHTML);
  expect(geometry).not.toMatch(/NaN|undefined/);
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText("Z");
  const spec = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  expect(spec.sourceTable.compiler).toBe("tri-state-function-table-v1");
  expect(spec.sourceTable.matrix).toEqual([[0], [1], ["Z"], ["Z"]]);
  await page.locator("#tab-trace").click();
  await page.locator("#trace-format").selectOption("json");
  const trace = JSON.parse(
    await downloaded(page, () => page.locator("#export-trace").click()),
  );
  for (const s of trace.trace)
    expect(s.signals.pin_y).toBe(s.signals.pin_oe ? "Z" : s.signals.pin_a);
  await page.locator("#trace-format").selectOption("vcd");
  const vcd = await downloaded(page, () =>
    page.locator("#export-trace").click(),
  );
  expect(vcd).toContain("bz v2");
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(spec.name);
  await page.locator("#seek").fill("4");
  await page.locator("#seek").dispatchEvent("input");
  await expect(
    page.locator(".register-table tr").filter({ hasText: "pin_y" }),
  ).toContainText("Z");
});

test("reviewed real datasheet automatically creates a sourced chip model", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/nexperia-74hc595.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText("74HC595 / 74HCT595");
  await expect(page.locator("#model-count")).toHaveText("7");
  await page.locator("#seek").fill("18");
  await page.locator("#seek").dispatchEvent("input");
  await expect(page.locator(".register-table")).toContainText("0xB3");
  await expect(
    page.locator(".register-table tr").filter({ hasText: "parallel_pins" }),
  ).toContainText("Z");
  await page.locator("#seek").fill("20");
  await page.locator("#seek").dispatchEvent("input");
  await expect(
    page.locator(".register-table tr").filter({ hasText: "parallel_pins" }),
  ).toContainText("0xB3");
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText(
    "Initial shift/storage values",
  );
  const spec = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  expect(spec.id).toBe("hc595");
  expect(spec.checks).toHaveLength(8);
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(spec.name);
});

test("automatic browser models preserve ID collisions and compile previously cached PDFs", async ({
  page,
}) => {
  await ready(page);
  const profile = documentProfiles[0],
    unrelated = profile.build(profile.source);
  unrelated.name = "Unrelated authored model";
  unrelated.sources[0].sha256 = "f".repeat(64);
  await page.locator("#model-file").setInputFiles({
    name: "unrelated.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(unrelated)),
  });
  await expect(page.locator("#model-title")).toHaveText(unrelated.name);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/nexperia-74hc595.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText("74HC595 / 74HCT595");
  await expect(page.locator("#model-count")).toHaveText("8");
  await expect(page.locator('[data-model="hc595"]')).toContainText(
    unrelated.name,
  );
  await page.locator("#tab-sources").click();
  const generated = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  expect(generated.id).not.toBe(unrelated.id);
  // Reproduce a workspace with the PDF cached before its profile was available.
  await page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("chipsim-workspace", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("models", "readwrite");
          tx.objectStore("models").delete(id);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    generated.id,
  );
  await page.reload();
  await expect(page.locator("#model-count")).toHaveText("7");
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/nexperia-74hc595.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText(generated.name);
  await expect(page.locator("#model-count")).toHaveText("8");
});

test("register-level PDF profile shares source checks, released pins, interrupt acknowledgment, and exported model metadata", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/ti-pca9555.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText(
    "PCA9555 · register-level I/O expander",
  );
  for (const [tick, pending, driver] of [
    [8, "1", "0"],
    [10, "1", "0"],
    [12, "0", "Z"],
  ]) {
    await page.locator("#seek").fill(String(tick));
    await page.locator("#seek").dispatchEvent("input");
    await expect(
      page
        .locator(".register-table tr")
        .filter({ hasText: "interrupt_pending" }),
    ).toContainText(pending);
    await expect(
      page.locator(".register-table tr").filter({ hasText: "int_driver" }),
    ).toContainText(driver);
  }
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText(
    "interrupt erratum",
  );
  const spec = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  expect(spec.registerMap).toHaveLength(8);
  expect(spec.registerInterface.kind).toBe("toggle-word-v1");
  expect(spec.checks).toHaveLength(15);
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(spec.name);
});

test("level-sensitive PDF compiles from complete rows with stable identity, follows enabled data, holds while closed, and persists without a model service", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/renesas-hd74hc77.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText(
    "HD74HC77 Datasheet · Function Table",
  );
  for (const [tick, value] of [
    [4, "0x0"],
    [6, "0x1"],
    [10, "0x1"],
  ]) {
    await page.locator("#seek").fill(String(tick));
    await page.locator("#seek").dispatchEvent("input");
    await expect(
      page.locator(".register-table tr").filter({ hasText: "pin_q" }),
    ).toContainText(value);
  }
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText("No change");
  await expect(page.locator("#source-panel")).toContainText("package latches");
  const spec = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  expect(spec.id).toBe("level-table-d12f71d4ad64-p3-tu1");
  expect(spec.sourceTable.compiler).toBe("retained-function-table-v1");
  expect(spec.checks).toHaveLength(8);
  expect(spec.sourceTable.instances).toHaveLength(1);
  expect(spec.registers).toHaveLength(0);
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(spec.name);
});

test("wrapped sequential definitions and clock alternatives compile identically from browser PDF geometry", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/ti-sn74ahc273-q1.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toContainText("SN74AHC273-Q1");
  for (const tick of [14, 15]) {
    await page.locator("#seek").fill(String(tick));
    await page.locator("#seek").dispatchEvent("input");
    await expect(
      page.locator(".register-table tr").filter({ hasText: "pin_q" }),
    ).toContainText("0x1");
  }
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText("L, H, ↓");
  await expect(page.locator("#source-panel")).toContainText("Q0");
  await expect(page.locator("#source-panel")).toContainText(
    "package replication and wiring are omitted",
  );
  const spec = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  expect(spec.id).toBe("state-table-832098c1b03b-p12-t71");
  expect(spec.sourceTable.rows[1].inputs[1]).toEqual({ clock: 13 });
  expect(spec.sourceTable.clock.pairs).toBe(true);
  expect(spec.sourceTable.retention).toEqual({
    symbol: "Q0",
    output: "Q",
    definition: "previous state",
  });
  expect(spec.sourceTable.instances).toHaveLength(1);
  expect(spec.registers).toHaveLength(3);
  expect(spec.checks).toHaveLength(32);
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(spec.name);
});

test("real binary function tables compile from PDF layout and display all independent channels", async ({
  page,
}) => {
  await ready(page);
  for (const part of ["00", "86"]) {
    await page
      .locator("#document-file")
      .setInputFiles("docs/references/nexperia-74hc" + part + ".pdf");
    await expect(page.locator("#import-progress")).toBeHidden();
    await expect(page.locator("#model-title")).toContainText(
      "74HC" + part + "; 74HCT" + part,
    );
    await page.locator("#tab-sources").click();
    await expect(page.locator("#source-panel")).toContainText(
      "Source function table",
    );
    await expect(page.locator("#source-panel")).toContainText("1A/1B/1Y");
    const spec = JSON.parse(
      await downloaded(page, () => page.locator("[data-export-model]").click()),
    );
    expect(spec.sourceTable.instances).toHaveLength(4);
    expect(spec.signals).toHaveLength(12);
    expect(spec.sourceTable.matrix).toEqual(
      part === "00" ? [[1], [1], [1], [0]] : [[0], [1], [1], [0]],
    );
  }
  await expect(page.locator("#model-count")).toHaveText("8");
  await page.reload();
  await expect(page.locator("#model-title")).toContainText("74HC86; 74HCT86");
});

test("hierarchical centered decoder headers compile in PDF.js with enable gating and every output preserved", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/renesas-hd74hc138.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toContainText("HD74HC138");
  await page.locator("#tab-sources").click();
  const exported = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  expect(exported.sourceTable.inputs).toEqual([
    "G1",
    "G2A",
    "G2B",
    "C",
    "B",
    "A",
  ]);
  expect(exported.sourceTable.outputs).toEqual(
    Array.from({ length: 8 }, (_, at) => "Y" + at),
  );
  expect(exported.checks).toHaveLength(64);
  const terminal = analyzeDocument(
    await extractPDFFile(resolve("docs/references/renesas-hd74hc138.pdf")),
  ).models[0].spec;
  expect(exported.sourceTable).toEqual(terminal.sourceTable);
  await page.locator("#advanced-controls").click();
  await page.locator("#input-events").fill(
    JSON.stringify([
      { tick: 0, signal: "pin_g1", value: 1 },
      { tick: 1, signal: "pin_a", value: 1 },
      { tick: 2, signal: "pin_g2a", value: 1 },
    ]),
  );
  await page.locator("#apply-events").click();
  await page.locator("#tab-trace").click();
  await page.locator("#trace-format").selectOption("json");
  const trace = JSON.parse(
    await downloaded(page, () => page.locator("#export-trace").click()),
  );
  expect(trace.trace[0].signals.pin_y0).toBe(0);
  expect(trace.trace[1].signals.pin_y1).toBe(0);
  expect(trace.trace[1].signals.pin_y0).toBe(1);
  expect(
    Array.from({ length: 8 }, (_, at) => trace.trace[2].signals["pin_y" + at]),
  ).toEqual(Array(8).fill(1));
  await page.reload();
  await expect(page.locator("#model-title")).toContainText("HD74HC138");
});

test("multiplexer PDF shares enable/select across four independent data channels", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/nexperia-74hc157.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toContainText("74HC157; 74HCT157");
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText(
    "Shared input pins: E, S",
  );
  const spec = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  expect(spec.signals).toHaveLength(14);
  expect(spec.sourceTable.instances).toEqual(
    [1, 2, 3, 4].map((n) => ["E", "S", n + "I0", n + "I1", n + "Y"]),
  );
  await page.locator("#tab-trace").click();
  await page.locator("#trace-format").selectOption("json");
  const exported = JSON.parse(
    await downloaded(page, () => page.locator("#export-trace").click()),
  );
  for (const snapshot of exported.trace)
    for (let channel = 1; channel <= 4; channel++)
      expect(snapshot.signals[`pin_${channel}y`]).toBe(
        snapshot.signals.pin_e
          ? 0
          : snapshot.signals[`pin_${channel}i${snapshot.signals.pin_s}`],
      );
  await page.reload();
  await expect(page.locator("#model-title")).toContainText("74HC157; 74HCT157");
});

test("sequential PDFs retain state, capture clock edges, preserve source symbols, and reload offline", async ({
  page,
}) => {
  await ready(page);
  for (const part of ["377", "273"]) {
    await page
      .locator("#document-file")
      .setInputFiles(`docs/references/nexperia-74hc${part}.pdf`);
    await expect(page.locator("#import-progress")).toBeHidden();
    await expect(page.locator("#model-title")).toContainText(
      `74HC${part}; 74HCT${part}`,
    );
    await page.locator("#tab-sources").click();
    await expect(page.locator("#source-panel")).toContainText("↑");
    if (part === "377")
      await expect(page.locator("#source-panel")).toContainText("no change");
    const spec = JSON.parse(
      await downloaded(page, () => page.locator("[data-export-model]").click()),
    );
    expect(spec.sourceTable.compiler).toBe("sequential-function-table-v1");
    expect(spec.sourceTable.instances).toHaveLength(8);
    expect(spec.signals).toHaveLength(18);
    expect(spec.checks).toHaveLength(32);
    await page.locator("#parameter-initialOutputs").fill("0xB3");
    await page.locator("#parameter-initialOutputs").press("Tab");
    await page.locator("#tab-trace").click();
    await page.locator("#trace-format").selectOption("json");
    const exported = JSON.parse(
      await downloaded(page, () => page.locator("#export-trace").click()),
    );
    let held = 0xb3,
      previousClock = exported.trace[0].signals.pin_cp;
    for (const [tick, snapshot] of exported.trace.entries()) {
      const signals = snapshot.signals;
      if (part === "273" && signals.pin_mr === 0) held = 0;
      else if (
        tick &&
        previousClock === 0 &&
        signals.pin_cp === 1 &&
        (part === "273" || signals.pin_e === 0)
      )
        held = Array.from(
          { length: 8 },
          (_, bit) => signals[`pin_d${bit}`] << bit,
        ).reduce((a, b) => a | b, 0);
      const actual = Array.from(
        { length: 8 },
        (_, bit) => signals[`pin_q${bit}`] << bit,
      ).reduce((a, b) => a | b, 0);
      expect(actual).toBe(held);
      previousClock = signals.pin_cp;
    }
  }
  const session = await downloaded(page, () =>
    page.locator("#session-menu").click(),
  );
  await page.reload();
  await expect(page.locator("#model-title")).toContainText("74HC273; 74HCT273");
  await expect(page.locator("#parameter-initialOutputs")).toHaveValue("0");
  await page.locator("#session-file").setInputFiles({
    name: "sequential-session.json",
    mimeType: "application/json",
    buffer: Buffer.from(session),
  });
  await expect(page.locator("#parameter-initialOutputs")).toHaveValue("179");
});

test("single-port GPIO original PDF compiles in PDF.js, preserves latch/interrupt semantics and persists", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/ti-tca9534.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText(
    "TCA9534 · register-level I/O expander",
  );
  for (const [tick, read, driver] of [
    [6, "0xB3", "Z"],
    [8, "0xB3", "0"],
    [10, "0xB3", "0"],
    [12, "0xBE", "Z"],
    [16, "0xB1", "Z"],
  ]) {
    await page.locator("#seek").fill(String(tick));
    await page.locator("#seek").dispatchEvent("input");
    await expect(
      page.locator(".register-table tr").filter({ hasText: "read_data" }),
    ).toContainText(read);
    await expect(
      page.locator(".register-table tr").filter({ hasText: "int_driver" }),
    ).toContainText(driver);
  }
  await page.locator("#seek").fill("20");
  await page.locator("#seek").dispatchEvent("input");
  await expect(
    page.locator(".register-table tr").filter({ hasText: "p00_driver" }),
  ).toContainText("Z");
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText("command pointer");
  const spec = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  expect(spec.registerMap.map(({ address }) => address)).toEqual([0, 1, 2, 3]);
  expect(spec.checks).toHaveLength(16);
  const terminal = analyzeDocument(
    await extractPDFFile("docs/references/ti-tca9534.pdf"),
  );
  expect(spec).toEqual(terminal.models[0].spec);
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(spec.name);
});

test("TUI-authored register banks verify a real manual and preserve 32-bit storage, traces and reload", async ({
  page,
}) => {
  const document = await extractPDFFile(
    resolve("docs/references/rp2040-datasheet.pdf"),
  );
  const { spec } = buildRegisterBank(document, {
    name: "Entered scratch register storage",
    width: 32,
    hardwarePriority: "before",
    rows: await readFile(
      "examples/rp2040-watchdog-scratch.registers.txt",
      "utf8",
    ),
    page: 549,
    quote: "Information persists through soft reset of the chip.",
    claim:
      "Table 549 supports the entered relative addresses and 32-bit scratch word storage.",
    assumptions:
      "No watchdog counter, address aliases, bootrom or reset domains modeled.",
  });
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/rp2040-datasheet.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await page.locator("#model-file").setInputFiles({
    name: "scratch.model.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(spec)),
  });
  await expect(page.locator("#model-title")).toHaveText(spec.name);
  await page.locator("#advanced-controls").click();
  await page.locator("#input-events").fill(
    JSON.stringify([
      { tick: 0, signal: "request", value: 1 },
      { tick: 1, signal: "address", value: 12 },
      { tick: 1, signal: "write_data", value: 0xdeadbeef },
      { tick: 1, signal: "write", value: 1 },
      { tick: 1, signal: "request", value: 0 },
      { tick: 2, signal: "write", value: 0 },
      { tick: 2, signal: "request", value: 1 },
      { tick: 3, signal: "address", value: 16 },
      { tick: 3, signal: "write_data", value: 0xffffffff },
      { tick: 3, signal: "write", value: 1 },
      { tick: 3, signal: "request", value: 0 },
      { tick: 4, signal: "write", value: 0 },
      { tick: 4, signal: "request", value: 1 },
      { tick: 5, signal: "reset", value: 1 },
    ]),
  );
  await page.locator("#apply-events").click();
  await page.locator("#seek").fill("4");
  await page.locator("#seek").dispatchEvent("input");
  await expect(
    page.locator(".register-table tr").filter({ hasText: "read_data" }),
  ).toContainText("0xFFFFFFFF");
  await page.locator("#tab-trace").click();
  await page.locator("#trace-format").selectOption("json");
  const exported = JSON.parse(
    await downloaded(page, () => page.locator("#export-trace").click()),
  );
  expect(exported.trace[2].signals.read_data).toBe(0xdeadbeef);
  expect(exported.trace[4].registers.value_SCRATCH1).toBe(0xffffffff);
  expect(exported.trace[5].registers.value_SCRATCH0).toBe(0);
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(spec.name);
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText(
    "Table 549 supports",
  );
});

test("register-table inventories match original PDF geometry in both engines and export unresolved review drafts", async ({
  page,
}) => {
  await ready(page);
  for (const filename of ["ti-tca9534.pdf", "ti-pca9555.pdf"]) {
    const document = await extractPDFFile(
      resolve("docs/references/" + filename),
    );
    const inventory = readRegisterTables(document);
    await page
      .locator("#document-file")
      .setInputFiles("docs/references/" + filename);
    await expect(page.locator("#import-progress")).toBeHidden();
    await page.locator(".document-item").filter({ hasText: filename }).click();
    await expect(page.locator("#document-info")).toContainText(
      "Register-table drafts · review required",
    );
    await expect(page.locator("#document-info")).toContainText(
      "not executable simulations",
    );
    await page.locator("#document-info summary").click();
    const rows = await downloaded(page, () =>
      page.locator("[data-register-draft]").click(),
    );
    expect(rows.trim()).toEqual(
      registerDraftRows(inventory.tables[0]).replace(/; /g, "\n"),
    );
    expect(rows).toContain("ro ? ?");
    expect(rows).toContain("rw 0xFF ?");
    const bundle = JSON.parse(
      await downloaded(page, () => page.locator("#export-sources").click()),
    );
    const browserDocument = bundle.documents.find(
      (d) => d.filename === filename,
    );
    expect(readRegisterTables(browserDocument)).toEqual(inventory);
    expect(browserDocument.analysis.registerTables).toEqual(inventory.tables);
    await page.locator("#close-document").click();
  }
  await page.reload();
  await page
    .locator(".document-item")
    .filter({ hasText: "ti-tca9534.pdf" })
    .click();
  await expect(page.locator("#document-info")).toContainText(
    "Register-table drafts · review required",
  );
});

test("opening an old cached manual refreshes local source tables and preserves its authored model and current experiment", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/ti-tca9534.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await ageBrowserCache(page, { editModel: true });
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(
    "My authored GPIO experiment",
  );
  await page.locator("#advanced-controls").click();
  await page
    .locator("#input-events")
    .fill('[{"tick":2,"signal":"external0","value":179}]');
  await page.locator("#apply-events").click();
  await page.locator("#seek").fill("7");
  await page.locator("#seek").dispatchEvent("input");
  await page.locator("#value-format").selectOption("decimal");
  await page.locator("#trace-format").selectOption("json");
  const before = await downloaded(page, () =>
      page.locator("#export-trace").click(),
    ),
    cursor = await page.locator("#tick-label").textContent(),
    requests = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.locator(".document-item").click();
  await expect(page.locator("#document-info")).toContainText(
    "Register-table drafts · review required",
  );
  await expect(page.locator("#document-info")).not.toContainText(
    "Refreshing source tables",
  );
  await expect(page.locator("#document-info")).not.toContainText(
    "Stale analysis",
  );
  const bundle = JSON.parse(
    await downloaded(page, () => page.locator("#export-sources").click()),
  );
  expect(bundle.documents[0].extractionVersion).toBe(EXTRACTION_VERSION);
  expect(bundle.documents[0].analysis).toBeUndefined();
  expect(bundle.documents[0].tableScanLimit).toBeUndefined();
  expect(bundle.documents[0].registerScanLimit).toBeUndefined();
  expect(readRegisterTables(bundle.documents[0]).tables[0].rows).toHaveLength(
    4,
  );
  expect(requests).toEqual([]);
  await page.locator("#close-document").click();
  await expect(page.locator("#tick-label")).toHaveText(cursor);
  await expect(page.locator("#value-format")).toHaveValue("decimal");
  expect(
    await downloaded(page, () => page.locator("#export-trace").click()),
  ).toEqual(before);
  await expect(page.locator("#model-count")).toHaveText("7");
  await page.reload();
  await page.locator(".document-item").click();
  await expect(page.locator("#document-info")).toContainText(
    "Register-table drafts · review required",
  );
  await page.locator("#close-document").click();
  // Explicit reimport must also replace all stale extraction metadata.
  await ageBrowserCache(page);
  await page.reload();
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/ti-tca9534.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  await expect(page.locator("#model-title")).toHaveText(
    "My authored GPIO experiment",
  );
  await expect(page.locator("#model-count")).toHaveText("7");
  await page.locator(".document-item").click();
  const reimported = JSON.parse(
    await downloaded(page, () => page.locator("#export-sources").click()),
  );
  expect(reimported.documents[0]).toEqual(bundle.documents[0]);
});

test("cached-manual refresh rejects changed or missing PDF bytes without replacing the source or experiment", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/ti-tca9534.pdf");
  await expect(page.locator("#import-progress")).toBeHidden();
  for (const [badBytes, reason] of [
    [
      [
        ...pdfFixture(
          "Different searchable source document. It does not contain the original hardware specification.",
        ),
      ],
      "fingerprint changed",
    ],
    ["missing", "Saved PDF bytes are unavailable"],
  ]) {
    await ageBrowserCache(page, { badBytes });
    await page.reload();
    await page.locator("#step").click();
    const cursor = await page.locator("#tick-label").textContent();
    await page.locator("#trace-format").selectOption("json");
    const before = await downloaded(page, () =>
      page.locator("#export-trace").click(),
    );
    await page.locator(".document-item").click();
    await expect(page.locator("#document-info")).toContainText(reason);
    await expect(page.locator("[data-register-draft]")).toHaveCount(0);
    const bundle = JSON.parse(
      await downloaded(page, () => page.locator("#export-sources").click()),
    );
    expect(bundle.documents[0].extractionVersion).toBeUndefined();
    expect(bundle.documents[0].analysis.diagnostics[0].reason).toBe(
      "Stale analysis",
    );
    await page.locator("#close-document").click();
    await expect(page.locator("#tick-label")).toHaveText(cursor);
    expect(
      await downloaded(page, () => page.locator("#export-trace").click()),
    ).toEqual(before);
    await expect(page.locator("#model-count")).toHaveText("7");
  }
});

test("the supplied ESP32-C6 manual opens the same reviewed PCNT model in PDF.js and supports numeric parameter experiments", async ({
  page,
}) => {
  test.setTimeout(120000);
  await ready(page);
  await page
    .locator("#document-file")
    .setInputFiles("docs/references/espressif-esp32-c6-trm.pdf");
  await expect(page.locator("#import-progress")).toBeHidden({ timeout: 90000 });
  await expect(page.locator("#model-title")).toHaveText(
    "ESP32-C6 · PCNT channel 0",
  );
  for (const [tick, count, magnitude] of [
    [9, "0x0000", "0x0000"],
    [11, "0xFFFF", "0x0001"],
    [13, "0xFFFE", "0x0002"],
    [19, "0x0000", "0x0000"],
  ]) {
    await page.locator("#seek").fill(String(tick));
    await page.locator("#seek").dispatchEvent("input");
    await expect(
      page.locator(".register-table tr").filter({ hasText: "pulse_count" }),
    ).toContainText(count);
    await expect(
      page.locator(".register-table tr").filter({ hasText: "magnitude" }),
    ).toContainText(magnitude);
  }
  await page.locator("#tab-sources").click();
  await expect(page.locator("#source-panel")).toContainText(
    "channel 1 disabled",
  );
  const spec = JSON.parse(
    await downloaded(page, () => page.locator("[data-export-model]").click()),
  );
  const terminal = analyzeDocument(
    await extractPDFFile("docs/references/espressif-esp32-c6-trm.pdf"),
  );
  expect(spec).toEqual(terminal.models[0].spec);
  await page.locator("#parameter-control_high_mode").fill("0x2");
  await page.locator("#parameter-control_high_mode").press("Tab");
  await page.locator("#trace-format").selectOption("json");
  const trace = JSON.parse(
    await downloaded(page, () => page.locator("#export-trace").click()),
  );
  expect(trace.parameters.control_high_mode).toBe(2);
  expect(trace.trace[11].registers.pulse_count).toBe(0);
  expect(trace.trace[11].signals.count_down).toBe(0);
  await page.reload();
  await expect(page.locator("#model-title")).toHaveText(spec.name);
});
