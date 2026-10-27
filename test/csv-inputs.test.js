import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readCSV } from "../src/tables/csv.js";
import { readStimulusCSV, readInputFile } from "../src/tables/stimulus.js";
import { readRegisterRows } from "../src/model/register-bank/read.js";
import { tableCommand } from "../src/tables/commands.js";
import { TuiState } from "../src/tui/state.js";
import { screenText } from "../src/tui/render.js";
import { validateModel } from "../src/model/validate.js";
import { digest } from "../src/hdl/io.js";

const run = promisify(execFile);
const cli = new URL("../scripts/chipsim.mjs", import.meta.url).pathname;
const example = new URL("../examples/csv/registers.csv", import.meta.url)
  .pathname;
const stimulus = new URL("../examples/csv/stimulus.csv", import.meta.url)
  .pathname;
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim csv "));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const bankArgs = (out, file = example) => [
  "registers",
  file,
  "--width",
  "32",
  "--priority",
  "after",
  "--name",
  "Example CSR",
  "--out",
  out,
];

test("CSV handles BOM, reordered named columns, CRLF and escaped quotes without inferring fields", () => {
  assert.deepEqual(
    readCSV('\uFEFFVALUE,NAME\r\n"a,b","quoted ""name"""\r\n\r\n', [
      "name",
      "value",
    ]),
    [{ value: "a,b", name: 'quoted "name"' }],
  );
  assert.deepEqual(
    readRegisterRows(
      'MASK,RESET,MODE,ADDRESS,NAME\n"0xFFFFFFFF",0,rw,0,CONTROL\n',
      32,
    ),
    [{ name: "CONTROL", address: 0, mode: "rw", reset: 0, mask: 4294967295 }],
  );
  for (const text of [
    "name,name\na,b",
    "name,extra\na,b",
    "name,value\na",
    "name,value\na,",
    'name,value\n"a,b',
    'name,value\n"a"trailing,b',
    'name,value\na"bad,b',
    "name,value\na,b,c",
    "name,value\n\u001ba,b",
  ])
    assert.throws(() => readCSV(text, ["name", "value"]));
  assert.throws(
    () => readCSV("name,value\na,b\nc,d", ["name", "value"], { maxRows: 1 }),
    /rows/,
  );
  assert.throws(
    () => readCSV("name,value\na,b", ["name", "value"], { maxBytes: 5 }),
    /bytes/,
  );
  for (const row of [
    "R,0,ro,0,1",
    "R,0,rw,?,1",
    "R,0,rw,0,0x100",
    "=SUM(A1),0,rw,0,1",
    '"R; X",0,rw,0,1',
  ])
    assert.throws(() =>
      readRegisterRows("name,address,mode,reset,mask\n" + row, 8),
    );
});

test("stimulus CSV enforces input direction, width and tick bounds and retains same-tick row order", () => {
  const signals = [
    { id: "pin", direction: "input", width: 32 },
    { id: "result", direction: "output", width: 1 },
  ];
  assert.deepEqual(
    readStimulusCSV(
      "tick,signal,value\n2,pin,0xffffffff\n0,pin,0b10\n2,pin,0o7\n",
      signals,
    ),
    [
      { tick: 0, signal: "pin", value: 2 },
      { tick: 2, signal: "pin", value: 4294967295 },
      { tick: 2, signal: "pin", value: 7 },
    ],
  );
  for (const row of [
    "1,result,1",
    "1,missing,1",
    "10001,pin,0",
    "-1,pin,1",
    "1,pin,0x100000000",
    "1,pin,=1+1",
    "1.5,pin,0",
    "1,pin,Z",
  ])
    assert.throws(() => readStimulusCSV("tick,signal,value\n" + row, signals));
});

test("register CSV produces source-verified runnable artifacts without Poppler and preserves outputs", async (t) => {
  const root = await workspace(t),
    out = join(root, "bank");
  const { stdout, stderr } = await run(
    process.execPath,
    [cli, "table", ...bankArgs(out)],
    {
      cwd: root,
      env: { ...process.env, PATH: root },
    },
  );
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.ok(report.checks.every((check) => check.passed));
  assert.equal(report.source.sha256, digest(await readFile(example)));
  assert.deepEqual(
    await readFile(report.artifacts["source.csv"]),
    await readFile(example),
  );
  const spec = JSON.parse(await readFile(report.artifacts["model.json"]));
  const bundle = JSON.parse(await readFile(report.artifacts["sources.json"]));
  assert.deepEqual(validateModel(spec, bundle.documents).warnings, []);
  assert.equal(spec.sources[0].mediaType, "text/csv");
  assert.match(spec.assumptions[0], /authored by a developer in a CSV/);
  const before = await readFile(join(out, "result.json"), "utf8");
  assert.equal((await tableCommand(bankArgs(out))).exitCode, 2);
  assert.equal(await readFile(join(out, "result.json"), "utf8"), before);
  // A changed quote does not pass source verification.
  bundle.documents[0].pages[0].text = "changed register table";
  assert.throws(() => validateModel(spec, bundle.documents), /CSV source page/);

  const s = new TuiState({ workspace: join(root, "workspace") });
  await s.initialize();
  await s.loadFile(report.artifacts["source.csv"]);
  await s.loadFile(report.artifacts["session.json"]);
  assert.deepEqual(s.model.warnings, []);
  assert.match(s.document.filePath, /\.csv$/);
  const inputs = await readInputFile(stimulus, s.model.signals);
  s.setInputs(inputs);
  assert.equal(s.trace[2].registers.value_CONTROL, 5);
  assert.equal(s.trace[2].signals.read_data, 5);
  assert.equal(s.trace[5].registers.value_STATUS, 2);
  assert.equal(s.trace[5].signals.read_data, 2);
  const saved = structuredClone(s.config.inputs);
  const invalid = join(root, "bad.csv");
  await writeFile(invalid, "tick,signal,value\n1,read_data,1\n");
  await assert.rejects(async () =>
    s.setInputs(await readInputFile(invalid, s.model.signals)),
  );
  assert.deepEqual(s.config.inputs, saved);
  s.stimulus.undo();
  assert.notDeepEqual(s.config.inputs, saved);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    s.columns = columns;
    s.rows = rows;
    s.setView("sources");
    assert.match(screenText(s), /CSV source page 1/);
    s.setView("registers");
    assert.match(screenText(s), /CONTROL/);
  }
  const conversion = await tableCommand([
    "stimulus",
    stimulus,
    "--model",
    report.artifacts["model.json"],
    "--out",
    join(root, "converted"),
  ]);
  assert.equal(conversion.exitCode, 0, JSON.stringify(conversion.result));
  assert.deepEqual(
    JSON.parse(await readFile(conversion.result.artifacts["inputs.json"])),
    inputs,
  );
  // CLI --inputs CSV exercises the same values in a standalone terminal snapshot.
  const snapshot = await run(
    process.execPath,
    [
      cli,
      ...report.tui.slice(1),
      "--inputs",
      stimulus,
      "--snapshot",
      "--view",
      "registers",
      "--at",
      "5",
      "--workspace",
      join(root, "cli-workspace"),
    ],
    { cwd: root },
  );
  assert.match(snapshot.stdout, /CONTROL/);
  assert.doesNotMatch(snapshot.stdout, /UNVERIFIED/);
});

test("invalid CSV and malformed table commands fail before creating a result directory", async (t) => {
  const root = await workspace(t),
    bad = join(root, "invalid.csv"),
    out = join(root, "out");
  await writeFile(bad, "name,address,mode,reset,mask\nR,0,rw,0,?\n");
  assert.equal((await tableCommand(bankArgs(out, bad))).exitCode, 2);
  assert.deepEqual((await readdir(root)).sort(), ["invalid.csv"]);
  for (const args of [
    ["registers"],
    [...bankArgs(out), "--width", "8"],
    ["stimulus", bad, "--out", out],
  ])
    assert.equal((await tableCommand(args)).exitCode, 2);
});
