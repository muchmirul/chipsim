import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { buildBehaviorTable } from "../src/model/behavior-table/build.js";
import { behaviorDraft } from "../src/model/behavior-table/authoring.js";
import { validateModel, ModelError } from "../src/model/validate.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, screenText, displayWidth } from "../src/tui/render.js";

const document = {
  id: "source",
  filename: "source.pdf",
  title: "Illustrative control reference",
  sha256: "c".repeat(64),
  pages: [
    {
      number: 1,
      text: "The entered rules are an explicitly chosen developer experiment.",
    },
  ],
};
const options = {
  name: "Entered control",
  inputs: "RESET ENABLE",
  outputs: "Q",
  states: "idle armed",
  rules: await readFile(
    new URL("../examples/control.rules.txt", import.meta.url),
    "utf8",
  ),
  page: 1,
  quote: document.pages[0].text,
  claim:
    "This fixture marks the experiment as developer-selected; it is not a vendor model.",
  assumptions: "An illustrative bounded control machine.",
};
const original = buildBehaviorTable(document, options).spec;
const event = (tick, pin, value) => ({ tick, signal: "pin_" + pin, value });
async function setup(t) {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-behavior-edit-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  state.documents.push(document);
  state.documentId = document.id;
  await state.installModel(structuredClone(original));
  state.setInputs([
    event(1, "enable", 1),
    event(2, "enable", 0),
    event(8, "reset", 1),
  ]);
  state.setDuration(20);
  state.seek(3);
  state.format = "decimal";
  state.zoom = 2;
  state.selected = 2;
  state.stimulus.schedule("pin_enable", 1, 10);
  state.seek(3);
  return state;
}
const clone = (value) => JSON.parse(JSON.stringify(value));

test("portable authoring records validate against executable behavior, ignore object-key order, and preserve appended independent checks", () => {
  assert.equal(original.authoring.kind, "behavior-table");
  assert.deepEqual(behaviorDraft(original).options.inputs, ["RESET", "ENABLE"]);
  function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  }
  assert.doesNotThrow(() => validateModel(sorted(original), [document]));
  const extra = {
    name: "Enabled transition remains high while disabled",
    ticks: 3,
    inputs: [event(1, "enable", 1), event(2, "enable", 0)],
    expect: { "signal.pin_q": 1, state: "state_armed" },
  };
  const extended = buildBehaviorTable(document, {
    ...options,
    additionalChecks: [extra],
  }).spec;
  assert.equal(extended.checks.length, 17);
  const recovered = behaviorDraft(extended);
  assert.deepEqual(recovered.options.additionalChecks, [extra]);
  assert.deepEqual(
    buildBehaviorTable(document, recovered.options).spec,
    extended,
  );
  assert.throws(
    () =>
      buildBehaviorTable(document, {
        ...recovered.options,
        rules: "* XX -> idle / 0",
      }),
    /Enabled transition remains high/,
  );
});

test("malformed/stale authoring metadata rejects import instead of overwriting hand-edited executable JSON", () => {
  for (const change of [
    (spec) => {
      spec.authoring = null;
    },
    (spec) => {
      spec.authoring.version = 2;
    },
    (spec) => {
      spec.authoring.kind = "profile";
    },
    (spec) => {
      spec.authoring.sourceId = "other";
    },
    (spec) => {
      spec.authoring.configuration.extra = true;
    },
    (spec) => {
      spec.authoring.configuration.states = "idle armed";
    },
    (spec) => {
      spec.authoring.configuration.rules = "process.exit()";
    },
    (spec) => {
      spec.authoring.configuration.assumptions = {};
    },
    (spec) => {
      spec.authoring.configuration.rules =
        spec.authoring.configuration.rules.replaceAll("\n", "; ");
    },
    (spec) => {
      spec.states[1].transitions[0].actions[1].value = 1;
    },
    (spec) => {
      spec.signals[0].label = "Other";
    },
    (spec) => {
      spec.scope = "A hand-written different scope";
    },
    (spec) => {
      spec.assumptions.push("A note not in the draft");
    },
    (spec) => {
      spec.exampleInputs[0].value = 1;
    },
    (spec) => {
      spec.checks[0].expect.state = "state_armed";
    },
  ]) {
    const spec = clone(original);
    change(spec);
    assert.throws(() => validateModel(spec, [document]), ModelError);
  }
  const custom = clone(original);
  custom.states[1].transitions[0].actions[1].value = 1;
  delete custom.authoring;
  assert.doesNotThrow(() => validateModel(custom, [document]));
  assert.equal(behaviorDraft(custom), null);
});

test("legacy entered models are editable only when complete generated behavior and assumptions can be reproduced", () => {
  const legacy = clone(original);
  delete legacy.authoring;
  const recovered = behaviorDraft(legacy);
  assert.ok(recovered);
  const rebuilt = buildBehaviorTable(document, recovered.options).spec;
  delete rebuilt.authoring;
  assert.deepEqual(rebuilt, legacy);
  for (const change of [
    (spec) => {
      spec.assumptions = spec.assumptions.filter(
        (text) => !text.startsWith("Developer-entered row 2:"),
      );
    },
    (spec) => {
      spec.assumptions.push("Developer-entered row 9: idle XX -> idle / 1");
    },
    (spec) => {
      spec.parameters[0].options[0] = "other";
    },
    (spec) => {
      spec.duration += 1;
    },
    (spec) => {
      spec.sources.push({ ...spec.sources[0], id: "other" });
    },
  ]) {
    const spec = clone(legacy);
    change(spec);
    assert.equal(behaviorDraft(spec), null);
  }
});

test("revision preview is read-only, commits preserve the whole compatible experiment, and backups restore both definition and configuration", async (t) => {
  const state = await setup(t),
    before = clone(state.session()),
    oldTrace = clone(state.trace),
    oldHistory = clone(state.stimulus.history);
  const revision = buildBehaviorTable(document, {
    ...options,
    id: original.id,
    name: "Forced-low experiment",
    rules: "* XX -> idle / 0",
    assumptions:
      "Force low as an explicit developer test override; not a vendor claim.",
  }).spec;
  const preview = state.previewRevision(revision);
  assert.equal(preview.trace[3].signals.pin_q, 0);
  assert.deepEqual(clone(state.session()), before);
  assert.deepEqual(state.trace, oldTrace);
  assert.deepEqual(state.stimulus.history, oldHistory);
  const backup = await state.reviseModel(revision);
  assert.deepEqual(JSON.parse(await readFile(backup, "utf8")), before);
  assert.equal(state.tick, 3);
  assert.equal(state.format, "decimal");
  assert.equal(state.zoom, 2);
  assert.equal(state.selected, 2);
  assert.deepEqual(state.config.inputs, before.inputs);
  assert.deepEqual(clone(state.config.parameters), before.parameters);
  assert.equal(state.config.duration, 20);
  assert.equal(state.trace[3].signals.pin_q, 0);
  assert.deepEqual(state.stimulus.history, { undo: [], redo: [] });
  assert.equal((await state.workspace.revisions(state.modelId)).length, 1);
  const savedRevision = clone(state.session());
  await state.loadSession(before, { backupCurrent: true });
  assert.deepEqual(clone(state.session()), before);
  assert.deepEqual(state.trace, oldTrace);
  const entries = await state.workspace.revisions(state.modelId);
  assert.equal(entries.length, 2);
  const other = entries.find((entry) => entry.path !== backup);
  assert.deepEqual(
    JSON.parse(await readFile(other.path, "utf8")),
    savedRevision,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(state.workspace.path, "models", original.id + ".json"),
        "utf8",
      ),
    ),
    before.model,
  );
});

test("incompatible experiments, invalid sessions, and failed writes leave active/disk models, cursor, trace, and stimulus history intact", async (t) => {
  const state = await setup(t),
    before = clone(state.session()),
    trace = clone(state.trace),
    history = clone(state.stimulus.history),
    file = join(state.workspace.path, "models", original.id + ".json"),
    disk = await readFile(file, "utf8");
  const check = async () => {
    assert.deepEqual(clone(state.session()), before);
    assert.deepEqual(state.trace, trace);
    assert.deepEqual(state.stimulus.history, history);
    assert.equal(await readFile(file, "utf8"), disk);
  };
  for (const altered of [
    { inputs: "RESET GO" },
    { outputs: "OTHER" },
    { states: "start armed", rules: options.rules.replaceAll("idle", "start") },
  ]) {
    const spec = buildBehaviorTable(document, {
      ...options,
      ...altered,
      id: original.id,
    }).spec;
    await assert.rejects(state.reviseModel(spec), /does not fit|Output names/);
    await check();
  }
  const revision = buildBehaviorTable(document, {
    ...options,
    id: original.id,
    name: "Renamed",
  }).spec;
  const save = state.workspace.saveModel.bind(state.workspace);
  state.workspace.saveModel = async () => {
    throw new Error("Simulated disk failure");
  };
  await assert.rejects(state.reviseModel(revision), /disk failure/);
  await check();
  state.workspace.saveModel = save;
  for (const altered of [
    { duration: 0 },
    { parameters: { initialState: "missing" } },
    { inputs: [event(1, "absent", 1)] },
    { modelId: "different" },
    { model: { ...before.model, authoring: null } },
  ]) {
    await assert.rejects(
      state.loadSession({ ...before, ...altered }, { backupCurrent: true }),
    );
    await check();
  }
  await writeFile(
    join(
      state.workspace.path,
      "revisions",
      original.id,
      "99999999999999999999999-junk.session.json",
    ),
    "{}",
  );
  assert.ok(
    (await state.workspace.revisions(original.id)).every(
      (entry) => !entry.name.includes("junk"),
    ),
  );
});

test("TUI draft editing supports error correction, review without mutation, external rows, compatible revisions, copies, and missing-source protection", async (t) => {
  const state = await setup(t),
    before = clone(state.session()),
    output = Object.assign(new EventEmitter(), {
      columns: 120,
      rows: 40,
      write() {},
    }),
    app = new TerminalApp(state, { output });
  async function idle() {
    for (let wait = 0; state.busy && wait < 200; wait++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(state.busy, false);
  }
  async function choose(value) {
    const at = state.menu.items.findIndex(
      (item) => item.value === value || item.value?.key === value,
    );
    assert.ok(at >= 0, String(value));
    state.menu.selected = at;
    app.key("", { name: "return" });
    await idle();
  }
  async function submit(value) {
    state.prompt.value = value;
    app.key("", { name: "return" });
    await idle();
  }
  app.key("E");
  assert.match(state.menu.title, /EDIT BEHAVIOR TABLE/);
  await choose("rules");
  await submit("idle 00 -> idle / 0");
  await choose("review");
  assert.match(state.message, /No row covers/);
  assert.deepEqual(clone(state.session()), before);
  const rules = join(state.workspace.path, "new.rules.txt");
  await writeFile(rules, "* XX -> idle / 0\n");
  await choose("rules");
  await submit("@" + rules);
  await choose("assumptions");
  await submit("Force Q low as an explicit developer test override.");
  await choose("quote");
  await submit("This quote is absent");
  assert.match(state.prompt.error, /Quote must occur/);
  await submit(options.quote);
  await choose("export");
  const exported = join(state.workspace.path, "draft.rules.txt");
  await submit(exported);
  assert.equal(await readFile(exported, "utf8"), "* XX -> idle / 0\n\n");
  await choose("review");
  assert.match(state.menu.title, /DRAFT REVIEW/);
  assert.ok(state.menu.items.some((item) => item.label === "Q: 1 → 0"));
  assert.ok(
    state.menu.items.some((item) => /Full trace:.*first 1/.test(item.label)),
  );
  assert.deepEqual(clone(state.session()), before);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    const frame = render(state);
    assert.equal(frame.length, rows);
    assert.ok(frame.every((row) => displayWidth(row.text) <= columns));
    assert.match(screenText(state), /Q: 1 → 0/);
  }
  await choose("differences");
  assert.match(state.menu.title, /TRACE DIFFERENCES/);
  assert.equal(state.menu.items[1].value.tick, 1);
  state.menu.selected = 1;
  app.key("", { name: "return" });
  assert.match(state.menu.title, /TICK 1 DIFFERENCES/);
  assert.ok(
    state.menu.items.some((item) => item.label === "signal.pin_q: 1 → 0"),
  );
  app.key("", { name: "return" });
  await choose("export");
  const compared = join(state.workspace.path, "review", "comparison.json");
  await submit(compared);
  const comparison = JSON.parse(await readFile(compared, "utf8"));
  assert.equal(comparison.format, "chipsim-trace-comparison");
  assert.deepEqual(comparison.baseline, before);
  assert.equal(comparison.comparison.firstDifference, 1);
  assert.equal(
    comparison.draft.authoring.configuration.rules,
    "* XX -> idle / 0",
  );
  assert.deepEqual(clone(state.session()), before);
  await choose("back");
  app.key("", { name: "return" });
  await choose("save");
  assert.equal(state.tick, 3);
  assert.equal(state.trace[3].signals.pin_q, 0);
  assert.equal(state.view, "wave");
  app.key("E");
  await choose("outputs");
  await submit("NEWQ");
  await choose("save");
  assert.match(state.message, /Output names\/order changed/);
  assert.equal(state.trace[3].signals.pin_q, 0);
  await choose("copy");
  assert.notEqual(state.modelId, before.modelId);
  assert.equal(state.trace[1].signals.pin_newq, 0);
  const previous = state.models.find((model) => model.id === before.modelId);
  assert.equal(previous.signals.at(-1).id, "pin_q");
  app.key("E");
  await choose("name");
  await submit("An unsaved name");
  app.key("", { name: "escape" });
  app.key("E");
  assert.equal(app.behaviorTableEditor.draft.options.name, "An unsaved name");
  await choose("discard");
  assert.equal(app.behaviorTableEditor.draft, null);
  const active = state.model.name;
  state.documents = [];
  app.key("E");
  assert.match(state.message, /Attach the original source PDF/);
  assert.equal(state.model.name, active);
});

test("valid faulting sessions remain inspectable while malformed session definitions cannot partially install", async (t) => {
  const state = await setup(t),
    custom = clone(original);
  delete custom.authoring;
  custom.id = "fault-example";
  custom.parameters.push({
    id: "divisor",
    type: "integer",
    label: "Divisor",
    min: 0,
    max: 1,
    default: 1,
  });
  custom.states.forEach((item) => {
    item.tick = [
      {
        target: "reg.behavior_state",
        value: { op: "div", args: [0, "param.divisor"] },
      },
    ];
  });
  await state.installModel(custom);
  const session = clone(state.session());
  session.parameters.divisor = 0;
  session.tick = 1;
  await state.loadSession(session);
  assert.equal(state.snapshot.phase, "fault");
  assert.equal(state.config.parameters.divisor, 0);
  const before = clone(state.session());
  await assert.rejects(state.loadSession({ ...before, duration: 0 }));
  assert.deepEqual(clone(state.session()), before);
});
