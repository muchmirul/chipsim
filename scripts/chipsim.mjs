#!/usr/bin/env node
import { documentProfiles } from "../src/model/profiles/index.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { screenText } from "../src/tui/render.js";
import { normalizeParameters } from "../src/model/engine.js";
import { views } from "../src/tui/views.js";
export async function main(args = process.argv.slice(2)) {
  const usage = `ChipSim · terminal hardware behavior workbench\nUsage: npm start -- [options]\n  --model pio|pru|flexio|udb|xmos|etpu|model.json\n  --document manual.pdf       Import a PDF; compile supported tables or reviewed profiles
  --list-profiles              List reviewed automatic document profiles\n  --dwfv /path/to/dwfv        Optional external viewer command
  --workspace .chipsim        Persistent local workspace directory\n  --params parameters.json    Parameter overrides\n  --inputs events.json        Timed input stimulus\n  --ticks 100                 Duration for document models\n  --snapshot                  Print one terminal frame without a TTY\n  --at 0 --columns 120 --rows 40  Snapshot dimensions and cursor\n  --view wave|inspect|log|sources|model|registers|stimulus\n  --no-color                  Disable colored text\n  --help                      Show this help\n\nInside the TUI: ? help · m models · p params · i pins · d import · c create · q quit.\nOptional waveform viewer: V opens the exported trace in installed dwfv.\n`;
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage);
    return;
  }
  if (args.includes("--list-profiles")) {
    process.stdout.write(
      "Reviewed automatic document profiles (exact PDF fingerprints):\n" +
        documentProfiles
          .map(
            (profile) =>
              `${profile.id} · ${profile.name}\n  PDF: ${profile.source.path}\n  SHA-256: ${profile.source.sha256}`,
          )
          .join("\n") +
        "\nOpen with --document PATH. Other PDFs can compile supported function tables or remain available for guided modeling.\n",
    );
    return;
  }
  const options = {};
  const values = new Set([
    "model",
    "document",
    "dwfv",
    "workspace",
    "params",
    "inputs",
    "ticks",
    "at",
    "columns",
    "rows",
    "view",
  ]);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].slice(2);
    if (
      !args[i].startsWith("--") ||
      (!values.has(key) && !["snapshot", "no-color"].includes(key))
    )
      throw new Error("Unknown option " + args[i]);
    if (values.has(key)) {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("Missing value for --" + key);
      options[key] = args[++i];
    } else options[key] = true;
  }
  if (!options.snapshot && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error(
      "ChipSim needs an interactive terminal. Use --snapshot for text output or --help for usage.",
    );
  const state = new TuiState({ workspace: options.workspace || ".chipsim" });
  await state.initialize();
  if (options.document) await state.loadFile(options.document);
  if (options.model) {
    if (state.models.some((m) => m.id === options.model))
      state.selectModel(options.model);
    else await state.loadFile(options.model);
  }
  if (options.params) {
    const supplied = JSON.parse(
      await readFile(resolve(options.params), "utf8"),
    );
    state.config.parameters = normalizeParameters(state.model.parameters, {
      ...state.config.parameters,
      ...supplied,
    });
    state.rebuild();
  }
  if (options.inputs)
    state.setInputs(
      JSON.parse(await readFile(resolve(options.inputs), "utf8")),
    );
  if (options.ticks) state.setDuration(Number(options.ticks));
  if (options.at) {
    const tick = Number(options.at);
    if (!Number.isInteger(tick) || tick < 0 || tick >= state.trace.length)
      throw new Error("--at must be 0–" + (state.trace.length - 1));
    state.seek(tick);
  }
  if (options.view) {
    if (!views.includes(options.view))
      throw new Error("Unknown view " + options.view);
    state.view = options.view;
  }
  if (options.snapshot) {
    for (const key of ["columns", "rows"])
      if (options[key]) {
        const value = Number(options[key]);
        if (!Number.isInteger(value) || value < 20 || value > 500)
          throw new Error("--" + key + " must be 20–500");
        state[key] = value;
      }
    process.stdout.write(screenText(state) + "\n");
    return;
  }
  const app = new TerminalApp(state, {
    color: !options["no-color"],
    viewer: options.dwfv || process.env.CHIPSIM_DWFV || "dwfv",
    onExit: (code) => process.exit(code),
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => app.close());
  process.once("uncaughtException", (error) => {
    process.stderr.write(error.stack + "\n");
    app.close(1);
  });
  process.once("exit", () => {
    if (!app.closed) app.close();
  });
  app.start();
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write("ChipSim: " + error.message + "\n");
    process.exitCode = 1;
  });
