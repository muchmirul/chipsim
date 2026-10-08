import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { extractPDFFile } from "../src/documents/extract-node.js";
import {
  readRegisterTables,
  registerDraftRows,
} from "../src/model/register-tables/read.js";
import { readRegisterRows } from "../src/model/register-bank/read.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { registerInventory } from "../src/ui/register-tables.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, displayWidth } from "../src/tui/render.js";
const path = new URL("../docs/references/ti-tca9534.pdf", import.meta.url)
  .pathname;
const tcaPromise = extractPDFFile(path);
const pcaPromise = extractPDFFile(
  new URL("../docs/references/ti-pca9555.pdf", import.meta.url).pathname,
);
const isolated = async () => {
  const d = await tcaPromise;
  return {
    ...d,
    pages: [structuredClone(d.pages.find((p) => p.number === 19))],
  };
};
const byText = (page, text) =>
  page.layoutLines.flatMap((l) => l.cells).find((c) => c.text === text);
function fixture() {
  const cell = (text, x, width = 60) => ({ text, x, width });
  const lines = [
    { y: 10, cells: [cell("Table 7. Register Map", 200, 200)] },
    {
      y: 25,
      cells: [
        cell("ADDRESS (HEX)", 40, 110),
        cell("REGISTER", 235),
        cell("PROTOCOL", 365),
        cell("POWER-UP DEFAULT", 515, 110),
      ],
    },
    {
      y: 45,
      cells: [
        cell("0x0C", 80, 30),
        cell("Alpha-State", 220, 90),
        cell("Read/write byte", 350, 90),
        cell("1111 0000", 530, 70),
      ],
    },
    {
      y: 65,
      cells: [
        cell("0x0E", 80, 30),
        cell("BetaState", 220, 90),
        cell("Read byte", 365, 60),
        cell("XXXX XXXX", 530, 70),
      ],
    },
    { y: 90, cells: [cell("Copyright publisher", 20, 120)] },
  ];
  return {
    sha256: "a".repeat(64),
    filename: "unfamiliar.pdf",
    pages: [
      {
        number: 1,
        text: lines.map((l) => l.cells.map((c) => c.text).join(" ")).join("\n"),
        layoutLines: lines,
      },
    ],
  };
}

test("actual TI register tables preserve addresses, byte access and unknown reset patterns without executable inference", async () => {
  for (const [promise, count, firstWritable] of [
    [tcaPromise, 4, 1],
    [pcaPromise, 8, 2],
  ]) {
    const document = await promise,
      { tables, diagnostics } = readRegisterTables(document);
    assert.equal(tables.length, 1);
    assert.deepEqual(diagnostics, []);
    const table = tables[0];
    assert.equal(table.page, 19);
    assert.equal(table.width, 8);
    assert.equal(table.reviewRequired, true);
    assert.deepEqual(
      table.rows.map((r) => r.address),
      Array.from({ length: count }, (_, i) => i),
    );
    assert.equal(table.rows[0].reset, null);
    assert.equal(table.rows[0].resetBits, "XXXXXXXX");
    assert.equal(table.rows[0].access, "ro");
    assert.equal(table.rows[firstWritable].reset, 255);
    assert.equal(table.rows[firstWritable].access, "rw");
    assert.equal(table.rows[firstWritable + firstWritable].reset, 0);
    assert.ok(
      table.rows.every(
        (r) => r.mask === undefined && r.sideEffects === undefined,
      ),
    );
    assert.throws(
      () => readRegisterRows(registerDraftRows(table), 8),
      /replace \?/,
    );
    const analysis = analyzeDocument({
      ...document,
      sha256: "f".repeat(64),
      filename: "unfamiliar.pdf",
    });
    assert.equal(analysis.models.length, 0);
    assert.equal(analysis.registerTables.length, 1);
  }
});

test("generic positioned register maps work without a device name, fingerprint or control-bit prefix", () => {
  const { tables, diagnostics } = readRegisterTables(fixture());
  assert.deepEqual(diagnostics, []);
  assert.equal(tables.length, 1);
  assert.deepEqual(
    tables[0].rows.map((r) => [r.name, r.address, r.access, r.reset]),
    [
      ["Alpha-State", 12, "rw", 240],
      ["BetaState", 14, "ro", null],
    ],
  );
  assert.equal(
    registerDraftRows(tables[0]),
    "Alpha_State 0x0C rw 0xF0 ?; BetaState 0x0E ro ? ?",
  );
  const document = fixture();
  document.pages[0].layoutLines[3].cells[1].text = "Alpha State";
  assert.throws(
    () => registerDraftRows(readRegisterTables(document).tables[0]),
    /unique aliases/,
  );
  const injected = fixture();
  injected.pages[0].layoutLines[2].cells[1].text = "<img src=x>";
  const html = registerInventory(injected);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.ok(!html.includes("<img"));
});

test("missing, ambiguous, qualified and malformed register cells reject the entire draft", async () => {
  const mutations = [
    (p) =>
      ["CONTROL", "REGISTER", "BITS"].forEach(
        (text) => (byText(p, text).x -= 30),
      ),
    (p) => (byText(p, "(HEX)").text = "(DECIMAL)"),
    (p) => (byText(p, "PROTOCOL").text = "ACCESS"),
    (p) => (byText(p, "DEFAULT").text = "DEFAULT (1)"),
    (p) => (byText(p, "Read/write").text = "Read/clear"),
    (p) => (byText(p, "XXXX").text = "ZZZZ"),
    (p) => (byText(p, "0×01").text = "0×00"),
    (p) => (byText(p, "0×01").text = "0×06"),
    (p) => {
      byText(p, "Input").text = "";
      byText(p, "Port").text = "";
    },
    (p) =>
      (p.layoutLines.find((l) =>
        l.cells.some((c) => c.text === "0×02"),
      ).cells[0].text = "0"),
    (p) =>
      p.layoutLines.splice(
        p.layoutLines.findIndex((l) => l.cells.some((c) => c.text === "0×03")),
        1,
      ),
    (p) =>
      (p.layoutLines.find((l) =>
        l.cells.some((c) => c.text === "0×01"),
      ).cells[3].text = "Input"),
    (p) => (byText(p, "PROTOCOL").x += 90),
    (p) => (byText(p, "0×01").width = 200),
    (p) =>
      (p.layoutLines
        .filter((line) => line.y > 640)
        .flatMap((line) => line.cells)
        .find((cell) => cell.text === "B1").text = "B3"),
    (p) =>
      (p.layoutLines.find((l) =>
        l.cells.some((c) => c.text === "Copyright"),
      ).cells[0].text = "NOTE:"),
    (p) =>
      (p.layoutLines
        .find((l) => l.cells.some((c) => c.text === "Command" && c.x > 270))
        .cells.at(-1).text = "Table (continued)"),
  ];
  for (const mutate of mutations) {
    const d = await isolated();
    mutate(d.pages[0]);
    const result = readRegisterTables(d);
    assert.equal(result.tables.length, 0, mutate.toString());
    assert.ok(result.diagnostics.length, mutate.toString());
  }
  const d = await isolated();
  d.pages[0].layoutLines = [];
  assert.match(readRegisterTables(d).diagnostics[0].reason, /geometry/);
});

test("invalid geometry and bounded scans never fabricate register facts", async () => {
  for (const mutate of [
    (p) => (p.layoutLines[0].y = NaN),
    (p) => (p.layoutLines[0].cells[0].width = -1),
    (p) => (p.layoutLines[0].cells[0].width = 0),
    (p) => (p.layoutLines[0].cells[0] = null),
    (p) => (p.layoutLines[0] = null),
    (p) => p.layoutLines.reverse(),
    (p) => (p.layoutLines[0].cells[0].text = null),
    (p) => p.layoutLines.find((line) => line.cells.length > 1).cells.reverse(),
  ]) {
    const d = await isolated();
    mutate(d.pages[0]);
    assert.equal(readRegisterTables(d).tables.length, 0);
  }
  assert.equal(readRegisterTables(null).tables.length, 0);
  assert.equal(readRegisterTables({ pages: {} }).tables.length, 0);
  const invalid = fixture();
  invalid.pages[0] = null;
  assert.equal(readRegisterTables(invalid).tables.length, 0);
  const d = fixture();
  d.registerScanLimit = 32;
  assert.match(readRegisterTables(d).diagnostics[0].reason, /limited to 32/);
  const wrong = fixture();
  wrong.pages[0].layoutLines[1].cells[0].text = "ADDRESS (HEX) (1)";
  assert.equal(readRegisterTables(wrong).tables.length, 0);
});

test("TUI selects source-derived drafts, retries unresolved fields and creates only an explicitly resolved storage model", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-register-draft-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const s = new TuiState({ workspace });
  await s.initialize();
  await s.loadFile(path);
  const initial = s.modelId,
    input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = input.pause = () => {};
  output.write = () => {};
  output.columns = 80;
  output.rows = 24;
  const app = new TerminalApp(s, { input, output });
  app.key("c");
  for (let i = 0; i < 4; i++) app.key("j");
  app.key("\r", { name: "return" });
  assert.match(s.menu.title, /REGISTER TABLE/);
  app.key("j");
  app.key("\r", { name: "return" });
  assert.equal(s.page, 19);
  const submit = async (text) => {
    if (text !== undefined) {
      app.key("", { name: "u", ctrl: true });
      for (const ch of text) app.key(ch, { name: ch });
    }
    app.key("\r", { name: "return" });
    for (let i = 0; i < 300 && s.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(s.busy, false);
  };
  await submit("Reviewed byte storage draft");
  await submit("32");
  assert.match(s.prompt.error, /eight-bit/);
  await submit("8");
  assert.match(s.prompt.defaultValue, /Input_Port 0x00 ro \? \?/);
  await submit();
  assert.match(s.prompt.error, /replace \?/);
  assert.equal(s.modelId, initial);
  await submit(
    "Input_Port 0 ro 255 0; Output_Port 1 rw 255 255; Polarity_Inversion 2 rw 0 255; Configuration 3 rw 255 255",
  );
  await submit("before");
  await submit("20");
  assert.match(s.prompt.error, /source page/);
  await submit("19");
  assert.equal(s.prompt.defaultValue, "Table 3. Command Byte Table");
  await submit();
  await submit();
  await submit(
    "Storage only; GPIO direction/inversion/INT logic is omitted. Input reset is a selected high scenario.",
  );
  assert.equal(s.modelId, "reviewed-byte-storage-draft");
  assert.equal(s.model.spec.registerMap.length, 4);
  assert.ok(!s.model.signals.some((pin) => pin.id === "int_driver"));
  assert.match(
    s.model.assumptions.join(" "),
    /No register map or semantics|no peripheral side effects|Final rows are developer-entered/,
  );
  s.setInputs([]);
  s.accessRegister("write", 1, 179);
  s.accessRegister("read", 1);
  assert.equal(s.snapshot.signals.read_data, 179);
  const openExport = () => {
    app.key("c");
    for (let i = 0; i < 4; i++) app.key("j");
    app.key("\r", { name: "return" });
    app.key("j");
    app.key("j");
    app.key("\r", { name: "return" });
  };
  const existing = join(workspace, "reviewed-rows.txt"),
    exported = join(workspace, "draft-rows.txt");
  await writeFile(existing, "Keep my reviewed rows");
  openExport();
  assert.match(s.prompt.label, /Export register row draft/);
  await submit(existing);
  assert.match(s.prompt.error, /File exists/);
  assert.equal(await readFile(existing, "utf8"), "Keep my reviewed rows");
  await submit(exported);
  assert.match(await readFile(exported, "utf8"), /Input_Port 0x00 ro \? \?/);
  assert.equal(s.modelId, "reviewed-byte-storage-draft");
  const restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadSession(s.session());
  assert.deepEqual(restored.trace, s.trace);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    s.columns = columns;
    s.rows = rows;
    const frame = render(s);
    assert.equal(frame.length, rows);
    assert.ok(frame.every((line) => displayWidth(line.text) <= columns));
  }
});
