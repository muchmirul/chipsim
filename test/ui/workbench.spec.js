import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
  await page
    .locator("#model-file")
    .setInputFiles({
      name: "counter.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(spec)),
    });
  await expect(page.locator("#model-title")).toHaveText(spec.name);
  await page.locator('[data-model="pio"]').click();
  await page
    .locator("#document-file")
    .setInputFiles({
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
  await page
    .locator("#model-file")
    .setInputFiles({
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
