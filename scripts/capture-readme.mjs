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
