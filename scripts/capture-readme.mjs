// Capture the real terminal renderer using isolated, validated experiments.
// No user workspace or runtime UI code is changed by this script.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render } from "../src/tui/render.js";
import { AgentMonitor } from "../src/tui/agent-monitor.js";
import { TraceReview } from "../src/tui/trace-review.js";
import { agentCommand } from "../src/agent/commands.js";
import { buildScenario, suggestScenarios } from "../src/model/templates.js";
import { buildRegisterBank } from "../src/model/register-bank/build.js";
import { buildBehaviorTable } from "../src/model/behavior-table/build.js";

const root = resolve(import.meta.dirname, "..");
const destination = join(root, "docs/screenshots");
const temporary = await mkdtemp(join(tmpdir(), "chipsim-readme-"));
const frames = [];
let stateNumber = 0;
await mkdir(destination, { recursive: true });

async function terminal() {
  const state = new TuiState({
    root,
    workspace: join(temporary, "workspace-" + stateNumber++),
  });
  await state.initialize();
  const input = new EventEmitter();
  const output = new EventEmitter();
  Object.assign(output, { columns: 110, rows: 36, write: () => true });
  const app = new TerminalApp(state, { input, output });
  app.draw();
  return { state, app };
}

function capture(id, state, recipe) {
  const rows = render(state);
  assert(rows.length <= state.rows);
  assert(!state.error, state.message);
  frames.push({
    id,
    columns: state.columns,
    height: state.rows,
    model: state.model.id,
    tick: state.tick,
    recipe,
    rows,
  });
  process.stdout.write(`Captured ${id}\n`);
}

async function command(args) {
  const response = await agentCommand(args);
  assert.equal(response.exitCode, 0, JSON.stringify(response.result));
  return response.result;
}

try {
  const pio = await terminal();
  pio.state.seek(18);
  pio.state.fit();
  capture(
    "waveforms",
    pio.state,
    "chipsim --model pio; seek tick 18; = fit trace",
  );
  pio.app.parameterMenu();
  capture("parameters", pio.state, "Same PIO experiment; p opens parameters");
  pio.state.menu = null;
  pio.state.seek(2);
  pio.state.setView("inspect");
  capture("blocks", pio.state, "PIO tick 2; 2 opens hardware blocks");
  pio.state.setView("log");
  capture(
    "events",
    pio.state,
    "PIO tick 2; 3 opens event log, changes-only default",
  );

  const esp = await terminal();
  await esp.state.loadFile(
    join(root, "docs/references/esp32-c6/espressif-esp32-c6-trm.pdf"),
  );
  esp.state.selectModel("esp32c6-gpio");
  esp.state.setView("sources");
  esp.state.searchSources("GPIO_OUT_REG");
  esp.state.page = 251;
  esp.state.sourceScroll = 21;
  capture(
    "sources",
    esp.state,
    "Import bundled ESP32-C6 TRM; select GPIO; 4 then / GPIO_OUT_REG; navigate to PDF page 251; j scroll to Simple GPIO Output",
  );
  esp.app.sourceSimulations.open();
  capture(
    "source-models",
    esp.state,
    "Same manual; o opens associated simulations",
  );
  esp.state.menu = null;
  esp.state.setInputs([]);
  esp.state.accessRegister("write", 0x24, 1);
  esp.state.accessRegister("write", 0x08, 1);
  assert.equal(esp.state.snapshot.signals.selected_driver, 1);
  esp.state.setView("registers");
  capture(
    "registers",
    esp.state,
    "GPIO0: u writes ENABLE_W1TS (0x24)=1, OUT_W1TS (0x08)=1; 6 opens all current values",
  );
  esp.app.traceDetail.open();
  capture(
    "step-details",
    esp.state,
    "At accepted GPIO_OUT_W1TS write; Enter opens complete step details",
  );
  esp.state.traceDetail = null;
  esp.state.setView("stimulus");
  esp.state.stimulusFilter = "request";
  capture(
    "stimulus",
    esp.state,
    "Same addressed accesses; 7 and / request display request-token events",
  );
  await esp.state.loadProgramFile(join(root, "examples/esp32c6-gpio.chip"));
  esp.state.programDebugger.toggleBreakpoint(9);
  esp.state.programDebugger.continue();
  esp.state.syncProgram();
  assert.equal(esp.state.programDebugger.status, "breakpoint");
  assert.equal(esp.state.tick, 5);
  assert.equal(esp.state.snapshot.signals.selected_driver, 1);
  esp.state.selected = esp.state.model.signals.findIndex(
    (s) => s.id === "selected_driver",
  );
  esp.state.fit();
  capture(
    "program",
    esp.state,
    "P examples/esp32c6-gpio.chip; breakpoint line 9 using K; C continues to tick 5",
  );
  esp.app.key("G");
  capture(
    "guides",
    esp.state,
    "Program view; G shows original-PDF verified ESP-IDF guide page 983",
  );
  esp.state.menu = null;
  esp.app.key("Q");
  esp.app.exportMenu();
  capture("exports", esp.state, "x opens CSV/JSON/VCD trace export choices");

  const nand = await terminal();
  await nand.state.loadFile(
    join(root, "docs/references/74hc00/nexperia-74hc00.pdf"),
  );
  nand.state.setView("model");
  // Scroll through the actual rendered model information to its source table.
  for (let scroll = 0; scroll < 400; scroll++) {
    nand.state.infoScroll = scroll;
    if (
      render(nand.state)
        .slice(3, 12)
        .some((r) => r.text.includes("SOURCE FUNCTION TABLE"))
    )
      break;
  }
  capture(
    "function-table",
    nand.state,
    "Import bundled 74HC00; 5 and j scroll to original source function table",
  );
  const behaviorOptions = {
    name: "Reviewed single NAND",
    inputs: "A B",
    outputs: "Y",
    states: "logic",
    rules: await readFile(join(root, "examples/nand.rules.txt"), "utf8"),
    page: 3,
    quote: "Quad 2-input NAND gate",
    claim: "Entered rows reviewed against the source function table.",
    assumptions:
      "One generic gate; normalized steps; no electrical timing or package replication.",
  };
  const entered = buildBehaviorTable(nand.state.document, behaviorOptions);
  await nand.state.installModel(entered.spec);
  nand.state.seek(3);
  nand.state.setView("wave");
  const draft = buildBehaviorTable(nand.state.document, {
    ...behaviorOptions,
    rules:
      "logic 0X -> logic / 1; logic X0 -> logic / 1; logic 11 -> logic / 1",
    claim:
      "Developer what-if experiment, intentionally forces output high; not vendor NAND behavior.",
  });
  const preview = nand.state.previewRevision(draft.spec);
  const review = new TraceReview(nand.app, preview, () => {});
  assert(review.comparison.changedTicks > 0);
  review.menu();
  capture(
    "behavior-review",
    nand.state,
    "Entered NAND rules; E draft deliberately forces Y=1; review full-trace differences without installing",
  );

  const rp = await terminal();
  await rp.state.loadFile(
    join(root, "docs/references/rp2040/rp2040-datasheet.pdf"),
  );
  rp.app.createScenario();
  capture(
    "builders",
    rp.state,
    "Import RP2040 manual; c opens guided builders",
  );
  rp.state.menu = null;
  for (const kind of ["counter", "fifo", "shifter"]) {
    const source = suggestScenarios(rp.state.document).find(
      (s) => s.kind === kind,
    );
    assert(source, `No real source excerpt for ${kind}`);
    const built = buildScenario(rp.state.document, {
      ...source,
      kind,
      width: 8,
      depth: 4,
      value: kind === "counter" ? 8 : 179,
      direction: kind === "counter" ? "up" : "lsb",
      match: "repeat",
      name: "Selected " + kind + " experiment",
      claim:
        "The excerpt motivates a generic scenario; selected rules are developer assumptions.",
      assumptions:
        "8-bit selected experiment, not a complete RP2040 peripheral; FIFO depth 4; normalized ticks.",
    });
    await rp.state.installModel(built.spec);
    rp.state.seek(kind === "counter" ? 8 : kind === "fifo" ? 4 : 18);
    rp.state.setView("wave");
    rp.state.fit();
    capture(
      kind,
      rp.state,
      "c builder with real RP2040 excerpt; explicit selected 8-bit scenario defaults, not inferred silicon behavior",
    );
  }
  const bank = buildRegisterBank(rp.state.document, {
    name: "Scratch storage experiment",
    width: 32,
    hardwarePriority: "before",
    rows: await readFile(
      join(root, "examples/rp2040-watchdog-scratch.registers.txt"),
      "utf8",
    ),
    page: 549,
    quote: "Information persists through soft reset of the chip.",
    claim:
      "The documented eight scratch words provide reviewed relative offsets for a storage experiment.",
    assumptions:
      "Synthetic whole-bank reset, not RP2040 soft reset; no watchdog or physical timing simulation.",
  });
  await rp.state.installModel(bank.spec);
  rp.state.setInputs([]);
  rp.state.accessRegister("write", 0x0c, 0xdeadbeef);
  rp.state.accessRegister("read", 0x0c);
  assert.equal(rp.state.snapshot.signals.read_data, 0xdeadbeef);
  rp.state.setView("registers");
  capture(
    "register-bank",
    rp.state,
    "c Register bank with examples/rp2040-watchdog-scratch.registers.txt; u write/read SCRATCH0=0xDEADBEEF; 6",
  );

  const tca = await terminal();
  await tca.state.loadFile(
    join(root, "docs/references/tca9534/ti-tca9534.pdf"),
  );
  tca.app.registerBankEditor.create(tca.state.document);
  assert(tca.state.menu);
  capture(
    "register-draft",
    tca.state,
    "TCA9534 manual; c Register bank offers actual extracted structural inventories, with masks requiring review",
  );

  const project = join(temporary, "esp32-c6");
  await command([
    "prepare",
    join(root, "docs/references/esp32-c6/espressif-esp32-c6-trm.pdf"),
    "--out",
    project,
  ]);
  await command(["context", project, "--model", "esp32c6-gpio"]);
  await command(["search", project, "GPIO_OUT_REG"]);
  const model = join(project, "models/esp32c6-gpio.model.json");
  const program = join(root, "examples/esp32c6-gpio.chip");
  await command([
    "program-check",
    program,
    "--model",
    model,
    "--project",
    project,
  ]);
  await command([
    "program-run",
    program,
    "--model",
    model,
    "--project",
    project,
    "--out",
    join(project, "runs/gpio-pulse"),
  ]);
  const watching = await terminal();
  const monitor = new AgentMonitor(watching.state, project);
  await monitor.initialize();
  assert(monitor.loaded, "The actual completed program run was not loaded");
  watching.state.setView("activity");
  watching.state.activityFilter = "program";
  capture(
    "agent-activity",
    watching.state,
    "chipsim --watch prepared-project; real prepare/context/search/program-check/program-run journal; 8 and / program",
  );
  monitor.close();

  await writeFile(
    join(destination, "frames.json"),
    JSON.stringify(
      {
        format: "chipsim-readme-terminal-captures",
        version: 1,
        description:
          "Unedited rows from src/tui/render.js, using real validated models and isolated temporary workspaces. PNG rendering only assigns fonts and terminal colors.",
        frames,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`Saved ${frames.length} actual terminal frames\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
