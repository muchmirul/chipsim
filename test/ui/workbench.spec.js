import { documentProfiles } from "../../src/model/profiles/index.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractPDFFile } from "../../src/documents/extract-node.js";
import { buildBehaviorTable } from "../../src/model/behavior-table/build.js";
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
  expect(
    trace.trace.slice(1, 5).map((snapshot) => snapshot.signals.pin_y),
  ).toEqual([1, 1, 0, 1]);
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
