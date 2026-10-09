import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProgramDebugger } from "../src/program/engine.js";
import { parseProgram } from "../src/program/parse.js";
import { verifyProgramGuides } from "../src/program/guides.js";
import { registerModel } from "../src/models/index.js";
import { builtinModels } from "../src/models/index.js";
import { documentProfiles } from "../src/model/profiles/index.js";
import { TuiState } from "../src/tui/state.js";
import programExamples from "../examples/programs/catalog.json" with { type: "json" };
import references from "../docs/references/manifest.json" with { type: "json" };
import { extractPDFFile } from "../src/documents/extract-node.js";
import { analyzeDocument } from "../src/model/from-document.js";
const root = new URL("../", import.meta.url).pathname;
const profile = documentProfiles.find((p) => p.id === "esp32c6-gpio");
const model = registerModel(profile.build(profile.source));
const program = (body) => parseProgram("model esp32c6-gpio\n" + body);

test("line debugger stops before breakpoints, distinguishes zero-time assertions and replays prior signal state", async () => {
  const parsed = parseProgram(
    await readFile(join(root, "examples/esp32c6-gpio.chip"), "utf8"),
  );
  const debug = new ProgramDebugger(model, parsed);
  debug.toggleBreakpoint(5);
  debug.continue();
  assert.equal(debug.status, "breakpoint");
  assert.equal(debug.steps.length, 0);
  debug.continue();
  assert.equal(debug.status, "halted");
  assert.equal(debug.tick, 7);
  debug.reset();
  debug.toggleBreakpoint(5);
  debug.toggleBreakpoint(9);
  debug.continue();
  assert.equal(debug.next.line, 9);
  assert.equal(debug.tick, 5);
  assert.equal(debug.snapshot.signals.selected_driver, 1);
  debug.step();
  assert.equal(debug.snapshot.signals.selected_driver, 0);
  debug.back();
  assert.equal(debug.tick, 5);
  assert.equal(debug.snapshot.signals.selected_driver, 1);
  debug.back();
  assert.equal(debug.tick, 2);
  assert.equal(debug.steps.at(-1).line, 7);
  debug.back();
  assert.equal(debug.tick, 2);
  assert.equal(debug.steps.at(-1).line, 6);
});

test("bad assertions, reset-rejected transactions, invalid capabilities and runaway branches stop with source diagnostics", () => {
  const pio = builtinModels.find((item) => item.id === "pio");
  const boolean = pio.parameters.find((item) => item.type === "boolean");
  assert.throws(
    () =>
      new ProgramDebugger(
        pio,
        parseProgram(`model pio\nparam ${boolean.id} invalid\nhalt`),
      ),
    /requires true or false/,
  );
  assert.throws(
    () => new ProgramDebugger(model, program("drive invented 1")),
    (error) => error.code === "PROGRAM" && error.line === 2,
  );
  const debug = new ProgramDebugger(
    model,
    program(
      "write GPIO_ENABLE_REG 1\nexpect signal.selected_driver == 1\nhalt",
    ),
  );
  assert.equal(debug.continue().ok, false);
  assert.equal(debug.error.line, 3);
  assert.equal(debug.tick, 1);
  assert.equal(debug.snapshot.signals.selected_driver, 0);
  const rejected = new ProgramDebugger(
    model,
    program("drive reset 1\nwrite GPIO_OUT_REG 9\nhalt"),
  );
  rejected.continue();
  assert.equal(rejected.error.line, 3);
  assert.equal(rejected.tick, 1);
  assert.equal(rejected.snapshot.registers.gpio_out, 0);
  assert.throws(
    () =>
      new ProgramDebugger(model, program("read GPIO_OUT_W1TS_REG into value")),
    /Unsupported read/,
  );
  assert.throws(
    () => new ProgramDebugger(model, program("drive request 1")),
    /read\/write/,
  );
  assert.throws(
    () => new ProgramDebugger(model, program("write INVENTED_REGISTER 1")),
    /Unknown addressed register/,
  );
  const loop = new ProgramDebugger(model, program("loop:\ngoto loop"), {
    maxSteps: 5,
  });
  assert.equal(loop.continue().status, "fault");
  assert.equal(loop.steps.length, 5);
  assert.equal(loop.tick, 0);
  const branch = new ProgramDebugger(
    model,
    program(
      "let local 3\nif $local == 3 goto right\nexpect reg.gpio_out == 99\nright:\nexpect reg.gpio_out == 0\nhalt",
    ),
  );
  assert.equal(branch.continue().ok, true);
  assert.deepEqual(
    branch.steps.map((step) => step.line),
    [2, 3, 6, 7],
  );
});

test("program guide checks actual PDF pages and rejects wrong quotes or another chip's guide", async () => {
  const text = await readFile(join(root, "examples/esp32c6-gpio.chip"), "utf8");
  assert.equal(
    (await verifyProgramGuides(parseProgram(text), model))[0].page,
    983,
  );
  await assert.rejects(
    verifyProgramGuides(
      parseProgram(
        text.replace(
          "Output level. 0: low ; 1: high",
          "This is a fabricated quote.",
        ),
      ),
      model,
    ),
    /does not occur/,
  );
  await assert.rejects(
    verifyProgramGuides(
      parseProgram(
        text.replace(
          "esp32-c6-esp-idf-programming-guide",
          "am335x-pru-programming-guide",
        ),
      ),
      model,
    ),
    /inapplicable/,
  );
  await assert.rejects(
    verifyProgramGuides(program("halt"), model),
    /Declare a programming guide/,
  );
});

test("quoted register names execute actual expander transactions and reject malformed names", () => {
  const profile = documentProfiles.find((p) => p.id === "tca9534");
  const expander = registerModel(profile.build(profile.source));
  const text =
    'model tca9534\nwrite "Output port" 0xA5\nexpect signal.p00_driver == Z\nwrite Configuration 0\nexpect signal.p00_driver == 1\nexpect signal.p01_driver == 0\nread "Output port" into latch\nexpect $latch == 165\nhalt';
  const debug = new ProgramDebugger(expander, parseProgram(text));
  assert.equal(debug.continue().ok, true);
  assert.equal(debug.tick, 3);
  assert.deepEqual(
    debug.trace.map((step) => step.signals.p00_driver),
    ["Z", "Z", 1, 1],
  );
  assert.equal(debug.variables.latch, 165);
  assert.throws(
    () =>
      new ProgramDebugger(
        expander,
        parseProgram('model tca9534\nwrite "Input port" 1'),
      ),
    /Unsupported write/,
  );
  assert.throws(
    () => parseProgram('model tca9534\nwrite "Output port 1'),
    /double quotes/,
  );
  assert.throws(
    () => parseProgram('model tca9534\nwrite "Output port"1'),
    /Separate operands/,
  );
  assert.throws(
    () => parseProgram('model tca9534\nwrite "Output \\x port" 1'),
    /Invalid JSON/,
  );
});

test("vendor-guide programs execute transfers, expander writes, PCNT controls and storage clocks with independent signal expectations", async () => {
  for (const example of programExamples.programs.filter(
    (example) => example.modelOrigin !== "function-table",
  )) {
    const profile = documentProfiles.find((p) => p.id === example.modelId);
    const model =
      builtinModels.find((m) => m.id === example.modelId) ||
      registerModel(profile.build(profile.source));
    const parsed = parseProgram(
      await readFile(join(root, example.path), "utf8"),
    );
    const guides = await verifyProgramGuides(parsed, model);
    const debug = new ProgramDebugger(model, parsed, { guides });
    assert.equal(
      debug.continue().ok,
      true,
      example.id + ": " + debug.error?.message,
    );
    if (model.kind === "builtin") {
      assert.deepEqual(
        [2, 6, 10, 14, 18, 22, 26, 30].map(
          (tick) => debug.trace[tick].signals.data,
        ),
        [1, 1, 0, 0, 1, 1, 0, 1],
        example.id,
      );
      assert.equal(debug.snapshot.registers.decoded, 179);
      assert.equal(debug.snapshot.phase, "success");
      debug.back();
      assert.equal(debug.next.op, "halt");
    } else if (example.modelId === "hc595") {
      assert.equal(debug.trace[26].signals.parallel_pins, 179);
      assert.equal(debug.snapshot.signals.parallel_pins, "Z");
      assert.equal(debug.snapshot.registers.storage, 179);
    } else if (example.modelId === "esp32c6-pcnt") {
      assert.equal(debug.trace[1].registers.pulse_count, 1);
      assert.equal(debug.trace[4].registers.pulse_count, 0);
      assert.equal(debug.trace[7].registers.pulse_count, 0);
      assert.equal(debug.trace[11].registers.pulse_count, 1);
      assert.equal(debug.snapshot.registers.pulse_count, 0);
    } else {
      assert.deepEqual(
        debug.trace.map((step) => step.signals.p00_driver),
        ["Z", "Z", 1, 1],
      );
      assert.equal(debug.variables.latch, 165);
    }
  }
});

test("guide-backed logic programs preserve independent gate, latch, decoder, clock and released-driver expectations at every tick", async () => {
  for (const example of programExamples.programs.filter(
    (example) => example.modelOrigin === "function-table",
  )) {
    const reference = references.documents.find((document) =>
      document.path.startsWith(`docs/references/${example.chip}/`),
    );
    const document = await extractPDFFile(join(root, reference.path));
    const analysis = analyzeDocument(document);
    const compiled = analysis.models.find(
      ({ spec }) => spec.id === example.modelId,
    );
    assert.ok(compiled, example.id);
    assert.ok(compiled.checks.every((check) => check.passed));
    const model = registerModel(compiled.spec);
    const program = parseProgram(
      await readFile(join(root, example.path), "utf8"),
    );
    const guides = await verifyProgramGuides(program, model);
    const debug = new ProgramDebugger(model, program, { guides });
    assert.equal(debug.continue().ok, true, debug.error?.message);
    // These oracles use the vendor's logical functions, not sourceTable.matrix,
    // generated acceptance cases or the program's own assertions.
    let retained = 0,
      previousClock = 0;
    for (const { signals: s } of debug.trace) {
      if (["74hc00", "74hc86"].includes(example.chip)) {
        for (let gate = 1; gate <= 4; gate++) {
          const a = s[`pin_${gate}a`],
            b = s[`pin_${gate}b`];
          assert.equal(
            s[`pin_${gate}y`],
            example.chip === "74hc00" ? 1 - (a & b) : a ^ b,
          );
        }
      } else if (example.chip === "74hc157") {
        for (let channel = 1; channel <= 4; channel++)
          assert.equal(
            s[`pin_${channel}y`],
            s.pin_e ? 0 : s[`pin_${channel}i${s.pin_s}`],
          );
      } else if (example.chip === "sn74lvc1g125") {
        assert.equal(s.pin_y, s.pin_oe ? "Z" : s.pin_a);
      } else if (example.chip === "hd74hc138") {
        const enabled = s.pin_g1 && !s.pin_g2a && !s.pin_g2b;
        const selected = 4 * s.pin_c + 2 * s.pin_b + s.pin_a;
        for (let output = 0; output < 8; output++)
          assert.equal(
            s[`pin_y${output}`],
            enabled && selected === output ? 0 : 1,
          );
      } else if (example.chip === "hd74hc77") {
        if (s.pin_enableg) retained = s.pin_data;
        assert.equal(s.pin_q, retained);
      } else {
        const generic = example.chip === "sn74ahc273-q1";
        const clock = generic ? s.pin_clk : s.pin_cp;
        const clear = generic ? s.pin_clr : s.pin_mr;
        if (example.chip !== "74hc377" && !clear) retained = 0;
        else if (
          !previousClock &&
          clock &&
          (example.chip !== "74hc377" || !s.pin_e)
        )
          retained = generic ? s.pin_d : s.pin_d0;
        assert.equal(generic ? s.pin_q : s.pin_q0, retained);
        if (!generic)
          for (let bit = 1; bit < 8; bit++) assert.equal(s[`pin_q${bit}`], 0);
        previousClock = clock;
      }
    }
    debug.back();
    assert.equal(debug.next.op, "halt");
  }
});

test("saved programs replay their actual executed prefix and reject altered stimulus atomically", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-program-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  state.models.push(model);
  state.selectModel(model.id);
  await state.loadProgramFile(join(root, "examples/esp32c6-gpio.chip"));
  state.programDebugger.step();
  state.programDebugger.step();
  state.syncProgram();
  const session = structuredClone(state.session());
  const trace = structuredClone(state.trace);
  state.programDebugger.continue();
  state.syncProgram();
  await state.loadSession(session, { persist: false });
  assert.deepEqual(state.trace, trace);
  assert.equal(state.programDebugger.next.line, 7);
  assert.throws(
    () => state.setParameter("watch_gpio", 1),
    /source program controls/,
  );
  const tampered = structuredClone(session);
  tampered.inputs.find((i) => i.signal === "write_data").value = 7;
  await assert.rejects(
    state.loadSession(tampered, { persist: false }),
    /does not match source-program replay/,
  );
  assert.deepEqual(state.trace, trace);
  const source = (
    await readFile(join(root, "examples/esp32c6-gpio.chip"), "utf8")
  )
    .split("\n")
    .slice(0, 4)
    .join("\n");
  state.programDebugger = await state.prepareProgram(
    source + "\nloop:\ngoto loop",
    model,
    state.documents,
    { maxSteps: 3 },
  );
  state.programDebugger.continue();
  state.syncProgram();
  const faultSession = structuredClone(state.session());
  await state.loadSession(session, { persist: false });
  await assert.rejects(
    state.loadSession(faultSession, { persist: false, rejectFault: true }),
    /simulation fault/,
  );
  assert.deepEqual(state.trace, trace);
  await state.loadSession(faultSession, { persist: false });
  assert.equal(state.programDebugger.status, "fault");
  assert.match(state.programDebugger.error.message, /step limit/);
});
