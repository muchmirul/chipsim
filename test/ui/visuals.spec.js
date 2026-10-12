import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { builtinModels, defaultParameters } from "../../src/models/index.js";
import { exportJSON } from "../../src/trace/export.js";
async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#model-title")).toHaveText("RP2040 PIO");
}
async function seek(page, tick) {
  await page.locator("#seek").fill(String(tick));
  await page.locator("#seek").dispatchEvent("input");
}
test("the full 64-state bound remains readable in a scrollable graph", async ({
  page,
}) => {
  await ready(page);
  const spec = JSON.parse(await readFile("examples/timer.model.json", "utf8"));
  for (let i = spec.states.length; i < 64; i++)
    spec.states.push({
      id: "unused_" + i,
      entry: [],
      tick: [],
      transitions: [],
      terminal: true,
    });
  await page
    .locator("#model-file")
    .setInputFiles({
      name: "many-states.model.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(spec)),
    });
  await expect(page.locator("#model-title")).toHaveText(spec.name);
  await page.locator("#tab-states").click();
  await expect(page.locator(".fsm-node")).toHaveCount(64);
  const geometry = await page
    .locator(".fsm-node")
    .last()
    .evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      scrollable:
        node.closest(".fsm-scroll").scrollHeight >
        node.closest(".fsm-scroll").clientHeight,
    }));
  expect(geometry.height).toBeGreaterThanOrEqual(60);
  expect(geometry.scrollable).toBe(true);
  await page.locator(".state-picker button").last().click();
  await expect(page.locator("#states-panel")).toContainText(
    "Rules from unused_63",
  );
});
test("FSM graph shows branches, terminal states and observed transitions at the shared cursor", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await page.locator("#tab-states").click();
  await seek(page, 32);
  await expect(page.locator(".fsm-node.current")).toHaveAttribute(
    "data-state",
    "wait",
  );
  await expect(page.locator(".fsm-edge.taken")).toHaveCount(1);
  await expect(page.locator("#states-panel")).toContainText(
    "ACK high when polled",
  );
  await expect(page.locator("#states-panel")).toContainText(
    "ACK low and deadline reached",
  );
  await seek(page, 35);
  await expect(page.locator(".fsm-node.current")).toHaveAttribute(
    "data-state",
    "success",
  );
  await expect(page.locator("#states-panel")).toContainText(
    "Terminal state latches",
  );
  const wait = page.locator("g[data-state=wait]");
  await wait.focus();
  await wait.press("Enter");
  await expect(page.locator("#states-panel")).toContainText("Rules from wait");
  await page.locator(".fsm-rule button").first().click();
  await expect(page.locator("#tick-label")).toHaveText("35 / 59");
  await page.screenshot({
    path: "/tmp/chipsim-states-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.locator("#states-panel")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/chipsim-states-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("bit-flow animation captures zero and one; reduced motion and declarative assignments remain truthful", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#parameter-payload").fill("2");
  await page.locator("#parameter-payload").press("Tab");
  await page.locator("#tab-flow").click();
  await expect(page.locator(".moving-bit")).toHaveCount(0);
  await seek(page, 2);
  await expect(page.locator(".moving-bit")).toHaveText("0");
  await expect(page.locator("#flow-panel")).toContainText("1 / 8 captured");
  await seek(page, 6);
  await expect(page.locator(".moving-bit")).toHaveText("1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".moving-bit")
      .evaluate((e) => getComputedStyle(e).animationName),
  ).toBe("none");
  await page.screenshot({
    path: "/tmp/chipsim-flow-desktop.png",
    fullPage: true,
  });
  await page.locator("#model-file").setInputFiles("examples/timer.model.json");
  await expect(page.locator("#model-title")).toHaveText(
    "Timer counter example",
  );
  await seek(page, 1);
  await expect(page.locator(".flow-operations")).toContainText("reg.count");
  await expect(page.locator("#flow-panel")).toContainText(
    "Executed assignments in order",
  );
});
test("references survive edits, load atomically, compare coverage and export their context", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await page.locator("#tab-comparison").click();
  await page.locator("#capture-reference").click();
  await page.locator("#parameter-ack").selectOption("missing");
  await expect(page.locator("#comparison-panel")).toContainText("first: 35");
  await page.locator("#first-difference").click();
  await expect(page.locator("#tick-label")).toHaveText("35 / 59");
  await expect(page.locator(".comparison-states")).toContainText("success");
  await expect(page.locator(".comparison-states")).toContainText("wait");
  await seek(page, 40);
  await expect(page.locator(".comparison-states")).toContainText("timeout");
  const download = page.waitForEvent("download");
  await page.locator("#export-comparison").click();
  const data = JSON.parse(
    await readFile(await (await download).path(), "utf8"),
  );
  expect(data.reference.session.parameters.ack).toBe("present");
  expect(data.current.session.parameters.ack).toBe("missing");
  expect(data.comparison.firstDifference).toBe(35);
  await page.screenshot({
    path: "/tmp/chipsim-comparison-desktop.png",
    fullPage: true,
  });
  const pio = builtinModels.find((m) => m.id === "pio"),
    params = defaultParameters(pio),
    artifact = JSON.parse(
      exportJSON(pio, pio.simulate(params).slice(0, 5), params),
    );
  await page.locator("#reference-file").setInputFiles({
    name: "recorded.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await expect(page.locator("#notice")).toContainText("Reference loaded");
  await expect(page.locator("#parameter-ack")).toHaveValue("missing");
  await expect(page.locator("#tick-label")).toHaveText("40 / 59");
  await expect(page.locator(".comparison-states")).toContainText("unavailable");
  artifact.trace[1].signals.data = 9;
  await page.locator("#reference-file").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await expect(page.locator("#notice")).toContainText("Invalid trace value");
  await expect(page.locator("#comparison-panel")).toContainText(
    "recorded.json",
  );
  await page.locator("#parameter-bits").selectOption("12");
  await page.locator("#capture-reference").click();
  await page.locator("#parameter-bits").selectOption("8");
  await seek(page, 70);
  await expect(page.locator(".comparison-states")).toContainText(
    "Current state: unavailable",
  );
  const saved = page.waitForEvent("download");
  await page.locator("#session-menu").click();
  expect(
    JSON.parse(await readFile(await (await saved).path(), "utf8")).tick,
  ).toBe(59);
  await expect(page.locator("#tick-label")).toHaveText("70 / 75");
  await page.locator("#tab-inspect").click();
  await expect(page.locator("#tick-label")).toHaveText("59 / 59");
  expect(errors).toEqual([]);
});
