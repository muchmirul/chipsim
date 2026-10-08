import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { agentCommand } from "../src/agent/commands.js";
import { prepareProject } from "../src/agent/project.js";
import { TuiState } from "../src/tui/state.js";
import { screenText } from "../src/tui/render.js";

const root = new URL("../", import.meta.url).pathname;
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, object) => writeFile(file, JSON.stringify(object));
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), "chipsim-agent-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

// An unfamiliar, text-searchable manual; no pinned compiler or table shortcut.
function manualFixture() {
  const stream =
    "BT /F1 12 Tf 40 700 Td (TestCounter: a 16-bit counter increments when enabled.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => String(offset).padStart(10, "0") + " 00000 n ").join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

async function authoredFixture(t) {
  const path = await temporary(t),
    pdf = join(path, "input.pdf"),
    project = join(path, "project");
  await writeFile(pdf, manualFixture());
  const prepared = await prepareProject(pdf, project);
  assert.equal(prepared.models.length, 0);
  const spec = await json(join(root, "examples/timer.model.json"));
  spec.id = "test-counter";
  spec.name = "Explicit assumed counter scenario";
  spec.scope =
    "Test fixture: counter increments from the source; compare, reset priority and toggle are explicit teaching assumptions, not vendor facts.";
  spec.sources = [
    {
      id: "flexio-manual",
      title: "Test fixture",
      sha256: prepared.source.sha256,
    },
  ];
  spec.evidence = [
    {
      id: "timer-features",
      sourceId: "flexio-manual",
      page: 1,
      quote: "a 16-bit counter increments when enabled",
      claim: "Width and enable; other rules are assumptions.",
    },
  ];
  const model = join(project, "models/counter.model.json");
  await save(model, spec);
  return { path, project, model, spec };
}

test("agent prepare handles the supplied ESP32-C6 manual and bounded, paginated source retrieval", async (t) => {
  const path = await temporary(t),
    project = join(path, "c6 project");
  const prepared = await agentCommand([
    "prepare",
    join(root, "docs/references/espressif-esp32-c6-trm.pdf"),
    "--out",
    project,
  ]);
  assert.equal(prepared.exitCode, 0);
  assert.deepEqual(
    prepared.result.models.map((model) => model.id),
    ["esp32c6-pcnt", "esp32c6-gpio"],
  );
  assert.equal(prepared.result.source.pages, 1394);
  assert.equal(
    prepared.result.source.sha256,
    "e08d5b61ebcfa2a78f9735e3f721817cb1dc2df9cf05096d2f0399eaba9f1734",
  );
  const search = await agentCommand([
    "search",
    project,
    "GPIO_OUT_REG",
    "--limit",
    "1",
  ]);
  assert.ok(search.result.total > 1);
  assert.equal(search.result.matches.length, 1);
  assert.equal(search.result.nextOffset, 1);
  const next = await agentCommand([
    "search",
    project,
    "GPIO_OUT_REG",
    "--limit",
    "1",
    "--offset",
    "1",
  ]);
  assert.notEqual(next.result.matches[0].page, search.result.matches[0].page);
  const page = await agentCommand(["page", project, "271", "--limit", "20"]);
  const rest = await agentCommand(["page", project, "271", "--offset", "20"]);
  assert.equal(page.result.nextOffset, 20);
  const full = await readFile(join(project, "pages/00271.txt"), "utf8");
  assert.equal(page.result.text + rest.result.text, full.trimEnd());
  assert.match(
    await readFile(join(project, "AGENTS.md"), "utf8"),
    /independently justified/,
  );
  const model = join(project, prepared.result.models[1].file);
  const checked = await agentCommand(["check", model, "--project", project]);
  assert.equal(checked.exitCode, 0);
  assert.equal(checked.result.checks.length, 16);
  const again = await agentCommand([
    "prepare",
    join(root, "docs/references/espressif-esp32-c6-trm.pdf"),
    "--out",
    project,
  ]);
  assert.equal(again.result.diagnostics[0].code, "OUTPUT_EXISTS");
  assert.equal((await json(model)).id, "esp32c6-gpio");
});

test("an unfamiliar PDF accepts an authored model and hands the exact experiment to the TUI", async (t) => {
  const { path, project, model } = await authoredFixture(t);
  const params = join(path, "params.json");
  await save(params, {}); // Deliberately partial: exports must include defaults.
  const output = join(path, "run one");
  const run = await agentCommand([
    "run",
    model,
    "--project",
    project,
    "--out",
    output,
    "--ticks",
    "0xA",
    "--params",
    params,
  ]);
  assert.equal(run.exitCode, 0);
  assert.equal(run.result.snapshots, 11);
  assert.deepEqual({ ...run.result.parameters }, { period: 8 });
  const trace = await json(run.result.artifacts["trace.json"]);
  assert.equal(trace.trace[8].signals.out, 1);
  assert.equal(trace.trace[10].registers.count, 2);
  assert.deepEqual(trace.parameters, { period: 8 });
  assert.match(
    await readFile(run.result.artifacts["trace.vcd"], "utf8"),
    /\$enddefinitions/,
  );
  assert.match(
    await readFile(run.result.artifacts["trace.csv"], "utf8"),
    /reg.count/,
  );
  const state = new TuiState({ workspace: join(path, "tui") });
  await state.initialize();
  await state.loadFile(join(project, "manual.pdf"));
  await state.loadFile(run.result.artifacts["session.json"]);
  assert.deepEqual(state.trace, trace.trace);
  assert.equal(state.model.warnings.length, 0);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    Object.assign(state, { columns, rows });
    assert.match(screenText(state), /counter/i);
  }
  const saved = await readFile(join(output, "trace.json"));
  const repeat = await agentCommand([
    "run",
    model,
    "--project",
    project,
    "--out",
    output,
  ]);
  assert.equal(repeat.result.diagnostics[0].code, "OUTPUT_EXISTS");
  assert.deepEqual(await readFile(join(output, "trace.json")), saved);
});

test("agent check reports invalid models, missing sources, bad citations and independently failed acceptance cases", async (t) => {
  const { path, project, model, spec } = await authoredFixture(t);
  for (const [mutate, code] of [
    [
      (s) => {
        s.states[0].tick = [{ target: "signal.reset", value: 1 }];
      },
      "MODEL_INVALID",
    ],
    [
      (s) => {
        s.sources[0].sha256 = "f".repeat(64);
      },
      "SOURCE_MISSING",
    ],
    [
      (s) => {
        s.evidence[0].page = 2;
      },
      "MODEL_INVALID",
    ],
    [
      (s) => {
        s.evidence[0].quote = "Invented behavior with no support";
      },
      "MODEL_INVALID",
    ],
    [
      (s) => {
        s.checks[0].expect["reg.count"] = 123;
      },
      "ACCEPTANCE",
    ],
  ]) {
    const changed = structuredClone(spec);
    mutate(changed);
    await save(model, changed);
    const checked = await agentCommand(["check", model, "--project", project]);
    assert.equal(checked.exitCode, 1);
    assert.equal(checked.result.ok, false);
    assert.equal(checked.result.diagnostics[0].code, code);
    if (code === "ACCEPTANCE")
      assert.equal(checked.result.checks[0].passed, false);
  }
  const output = join(path, "failed-run");
  const failed = await agentCommand([
    "run",
    model,
    "--project",
    project,
    "--out",
    output,
  ]);
  assert.equal(failed.exitCode, 1);
  await assert.rejects(access(output));
});

test("forged extraction text cannot satisfy provenance and changed PDF bytes reject source reads", async (t) => {
  const { project, model, spec } = await authoredFixture(t);
  const sourceFile = join(project, "sources.json"),
    manifestFile = join(project, "chipsim.project.json");
  const cache = await json(sourceFile),
    manifest = await json(manifestFile);
  const invented =
    "This fabricated quote should never pass fresh PDF verification";
  cache.documents[0].pages[0].text = invented;
  await save(sourceFile, cache);
  const changed = await agentCommand(["page", project, "1"]);
  assert.equal(changed.result.diagnostics[0].code, "CACHE_CHANGED");
  // Even coordinated edits to the cache and its digest cannot make check trust it.
  manifest.bundleSha256 = createHash("sha256")
    .update(await readFile(sourceFile))
    .digest("hex");
  await save(manifestFile, manifest);
  spec.evidence[0].quote = invented;
  await save(model, spec);
  const forged = await agentCommand(["check", model, "--project", project]);
  assert.equal(forged.result.diagnostics[0].code, "MODEL_INVALID");
  assert.match(forged.result.diagnostics[0].message, /quote does not occur/);
  await writeFile(join(project, "manual.pdf"), "%PDF- Changed bytes");
  const changedPDF = await agentCommand(["search", project, "counter"]);
  assert.equal(changedPDF.result.diagnostics[0].code, "SOURCE_CHANGED");
  await rm(join(project, "manual.pdf"));
  assert.equal(
    (await agentCommand(["check", model, "--project", project])).result.ok,
    false,
  );
});

test("runtime faults retain inspectable artifacts but return a failing status", async (t) => {
  const { project, model, spec, path } = await authoredFixture(t);
  spec.parameters.push({ id: "fault", type: "boolean", default: false });
  spec.states[0].tick = [
    {
      target: "reg.count",
      value: {
        op: "select",
        args: ["param.fault", { op: "div", args: [1, 0] }, "reg.count"],
      },
    },
  ];
  await save(model, spec);
  const params = join(path, "params.json");
  await save(params, { fault: true });
  const run = await agentCommand([
    "run",
    model,
    "--project",
    project,
    "--out",
    join(path, "fault"),
    "--params",
    params,
  ]);
  assert.equal(run.exitCode, 1);
  assert.equal(run.result.diagnostics[0].code, "SIMULATION_FAULT");
  assert.equal(
    (await json(run.result.artifacts["trace.json"])).trace.at(-1).phase,
    "fault",
  );
  assert.equal(
    (await json(run.result.artifacts["session.json"])).parameters.fault,
    true,
  );
});

test("agent doctor preserves the protocol version and reports unavailable dependencies without a TTY", async () => {
  const available = await agentCommand(["doctor"]);
  assert.equal(available.exitCode, 0);
  assert.equal(available.result.version, 1);
  assert.equal(available.result.toolVersion, "0.3.0");
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [join(root, "scripts/chipsim.mjs"), "agent", "doctor"],
      { env: { ...process.env, PATH: "/chipsim-no-programs" } },
    ),
    (error) => {
      const report = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(report.version, 1);
      assert.equal(report.ok, false);
      assert.equal(report.diagnostics.length, 2);
      assert.equal(error.stderr, "");
      return true;
    },
  );
});

test("agent CLI gives one JSON result without a TTY and rejects ambiguous or unbounded arguments", async (t) => {
  const path = await temporary(t);
  for (const args of [
    ["unknown"],
    ["check"],
    ["check", "x", "--project"],
    ["search", "x", "q", "--limit", "51"],
    ["page", "x", "1", "--limit", "16001"],
    ["check", "x", "--project", "p", "--project", "q"],
    ["run", "x", "--project", "p", "--out", "r", "--ticks", "1e2"],
    ["check", "x", "--extra", "p"],
  ]) {
    const reply = await agentCommand(args);
    assert.equal(reply.exitCode, 2, JSON.stringify(args));
    assert.equal(reply.result.ok, false);
  }
  const child = await promisify(execFile)(
    process.execPath,
    [join(root, "scripts/chipsim.mjs"), "agent", "help"],
    { cwd: path },
  );
  assert.equal(child.stderr, "");
  assert.equal(JSON.parse(child.stdout).ok, true);
  await mkdir(join(path, "empty"));
  await writeFile(join(path, "bad.pdf"), "Not a PDF");
  const bad = await agentCommand([
    "prepare",
    join(path, "bad.pdf"),
    "--out",
    join(path, "partial"),
  ]);
  assert.equal(bad.exitCode, 1);
  await assert.rejects(access(join(path, "partial")));
  const existing = await agentCommand([
    "prepare",
    join(path, "bad.pdf"),
    "--out",
    join(path, "empty"),
  ]);
  assert.equal(existing.result.diagnostics[0].code, "OUTPUT_EXISTS");
  await access(join(path, "empty"));
});
