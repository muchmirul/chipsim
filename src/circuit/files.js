import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import {
  readBounded,
  readJSON,
  createDirectory,
  writeJSON,
  jsonText,
} from "../agent/io.js";
import { digest } from "../hdl/io.js";
import { runHDL } from "../hdl/run.js";
import { scaleFs } from "../hdl/time.js";
import { waveformModel } from "../hdl/trace.js";
import { exportCSV, exportVCD } from "../trace/export.js";
import { localPath } from "../design/store.js";
import { compileCircuit, circuitLimits } from "./model.js";
import { checkCoverage, evaluateStep, initialSnapshot } from "./relation.js";
import {
  generatedHDL,
  symbolicSMT,
  stimulusBench,
  correspondenceBench,
  hdlManifest,
  validateStimulus,
} from "./hdl.js";

const modules = [
  "expression.js",
  "bdd.js",
  "model.js",
  "relation.js",
  "hdl.js",
  "files.js",
  "import.js",
];
export async function compilerIdentity() {
  const files = Object.fromEntries(
    await Promise.all(
      modules.map(async (name) => [
        name,
        digest(await readFile(new URL(name, import.meta.url))),
      ]),
    ),
  );
  return {
    id: "chipsim-connected-circuit",
    version: 1,
    sha256: digest(jsonText(files)),
    files,
  };
}
export async function readCircuit(file) {
  const bytes = await readBounded(file, circuitLimits.fileBytes);
  const model = compileCircuit(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  return {
    model,
    bytes,
    source: { path: resolve(file), sha256: digest(bytes), bytes: bytes.length },
  };
}
export const relationDescription = (model) => ({
  format: "chipsim-connected-relation",
  version: 1,
  circuit: model.spec,
  semantics: {
    clock: model.clock,
    edge: "rising",
    initialization: "explicit binary state and inputs; initial clock 0",
    sampling:
      "all guards/data read the same old-state and sampled-input network",
    commit: "simultaneous",
    outputSettling: "acyclic combinational network re-evaluated after commit",
    priority: "larger explicit integer wins; winning ties must agree",
    unsupported: [
      "asynchronous controls",
      "multiple clocks",
      "latches",
      "memories/ports",
      "unknown/uninitialized values",
      "resolved buses",
      "black boxes",
      "combinational loops",
      "implicit counters, state ages or pending-event queues",
      "analog/physical timing",
    ],
  },
  structuralDependencies: [...model.connections.values()].map(
    ({ from, to, slice }) => ({ from, to, slice }),
  ),
  domain: {
    stateBits: model.stateBits,
    inputBits: model.domainBits - model.stateBits,
    binaryAssignmentsPerEdge: (1n << BigInt(model.domainBits)).toString(),
  },
});

function exhaustiveCases(model) {
  if (model.domainBits > 12)
    throw new Error(
      "Exhaustive native correspondence is limited to 12 state/input bits (4096 cases); supply explicit --cases for larger domains. Symbolic rule coverage remains separate.",
    );
  const entries = [
    ...model.state.map((entry) => ({ ...entry, group: "state" })),
    ...model.inputs
      .filter((entry) => entry.id !== model.clock)
      .map((entry) => ({ ...entry, group: "inputs" })),
  ];
  return Array.from({ length: 2 ** model.domainBits }, (_, index) => {
    let value = BigInt(index);
    const snapshot = {
      state: {},
      inputs: { [model.clock]: 1 },
      previousClock: 0,
    };
    for (const entry of entries) {
      snapshot[entry.group][entry.id] =
        "0x" + (value & ((1n << BigInt(entry.width)) - 1n)).toString(16);
      value >>= BigInt(entry.width);
    }
    return snapshot;
  });
}

export async function buildCircuit(file, destination, options = {}) {
  const loaded = await readCircuit(file),
    { model, bytes, source } = loaded,
    coverage = checkCoverage(model);
  if (!coverage.ok)
    return { ok: false, status: coverage.status, coverage, source };
  const verification = options.operation === "verify";
  let cases, expected, stimulus;
  if (verification) {
    cases = options.cases
      ? await readJSON(options.cases, 1048576)
      : exhaustiveCases(model);
    if (!Array.isArray(cases) || !cases.length || cases.length > 4096)
      throw new Error("Correspondence needs 1..4096 explicit cases");
    expected = cases.map((snapshot) => {
      const result = evaluateStep(model, snapshot);
      if (result.event !== "rising")
        throw new Error(
          "Correspondence cases must declare a sampled rising edge",
        );
      return result;
    });
  } else
    stimulus = validateStimulus(
      model,
      options.stimulus
        ? await readJSON(options.stimulus, 1048576)
        : {
            format: "chipsim-circuit-stimulus",
            version: 1,
            duration: 10,
            events: [],
          },
    );
  let rtl = options.rtl
    ? await readBounded(options.rtl, 1048576)
    : Buffer.from(generatedHDL(model));
  if (options.nativeWrapper)
    rtl = Buffer.concat([rtl, Buffer.from("\n" + options.nativeWrapper.text)]);
  return createDirectory(destination, async (root) => {
    const artifacts = {},
      save = async (name, content) => {
        const data = Buffer.from(
          typeof content === "string" || Buffer.isBuffer(content)
            ? content
            : jsonText(content),
        );
        await writeFile(join(root, name), data, { flag: "wx" });
        artifacts[name] = { sha256: digest(data), bytes: data.length };
      };
    await save("source.json", bytes);
    await save("relation.json", relationDescription(model));
    await save("coverage.json", coverage);
    if (options.lowering) await save("lowering.json", options.lowering);
    if (options.loweredNetlist)
      await save("lowered.json", options.loweredNetlist);
    await save("relation.smt2", symbolicSMT(model));
    await save("generated.sv", generatedHDL(model));
    await save("circuit.sv", rtl);
    await save(
      "testbench.sv",
      verification
        ? correspondenceBench(model, cases, options.nativeWrapper)
        : stimulusBench(model, stimulus),
    );
    await save("sim.project.json", hdlManifest());
    await save("chipsim.lock.json", {
      format: "chipsim-lock",
      version: 1,
      dependencies: [],
    });
    await save("chipsim.design.json", {
      format: "chipsim-design",
      version: 1,
      id: model.spec.id,
      tasks: {
        simulate: {
          adapter: "hdl",
          options: { project: "sim.project.json", debug: false },
          outputs: [{ path: "out/waveform.json", kind: "waveform" }],
        },
      },
      targets: {
        simulation: {
          tasks: ["simulate"],
          requiredChecks: ["simulate:simulation", "simulate:outputs"],
        },
      },
    });
    if (verification) {
      await save("cases.json", cases);
      await save("expected.json", expected);
    } else
      await save("stimulus.json", {
        format: "chipsim-circuit-stimulus",
        version: 1,
        duration: stimulus.duration,
        events: stimulus.events.map(({ width, value, ...event }) => ({
          ...event,
          value: "0x" + value.toString(16),
        })),
      });
    let status = "built",
      ok = true,
      native = null,
      correspondence = null,
      captureError = null;
    if (["run", "verify"].includes(options.operation)) {
      const run = await runHDL(
        join(root, "sim.project.json"),
        join(root, "native"),
        { debug: false, signal: options.signal, owners: options.owners },
      );
      native = run.result;
      try {
        const inventory = await readJSON(
          join(root, "native/artifacts.json"),
          4 * 1048576,
        );
        if (
          inventory.format !== "chipsim-artifact-manifest" ||
          !Array.isArray(inventory.artifacts)
        )
          throw new Error("Invalid native artifact inventory");
        await save("native-artifacts.json", inventory);
      } catch (error) {
        captureError =
          "Native evidence inventory unavailable: " + error.message;
      }
      ok = native.ok && !captureError;
      status = ok ? "simulation-only" : "inconclusive";
      if (run.waveform) {
        const replay = waveformModel(run.waveform);
        await save("waveform.json", run.waveform);
        await save("trace.csv", exportCSV(replay, replay.simulate()));
        await save("trace.vcd", exportVCD(replay, replay.simulate()));
        if (verification && native.ok) {
          correspondence = compareNative(model, run.waveform, expected);
          ok = correspondence.ok && !captureError;
          status = captureError ? "inconclusive" : correspondence.status;
          await save("correspondence.json", correspondence);
        }
      } else if (verification)
        correspondence = {
          ok: false,
          status: "inconclusive",
          message: "Native execution produced no complete waveform",
        };
    }
    const report = {
      format: "chipsim-circuit-bundle",
      version: 1,
      ok,
      status,
      circuit: model.spec.id,
      source,
      compiler: await compilerIdentity(),
      coverage,
      artifacts,
      native,
      correspondence,
      ...(captureError ? { captureError } : {}),
      ...(options.lowering ? { lowering: options.lowering } : {}),
      scope: verification
        ? "Native one-edge correspondence only; arbitrary state injection belongs to the verification harness. No temporal/reachability/formal equivalence or physical proof."
        : "Declared connected binary circuit; source-free authored provenance. Native traces are observations; symbolic rule coverage is a separate result.",
      ...(options.rtl
        ? { comparedRTL: { path: resolve(options.rtl), sha256: digest(rtl) } }
        : {}),
      tui: ["chipsim", "--circuit", join(root, "circuit.json")],
      nativeTui: native?.tui ?? null,
    };
    const { circuitViewModel, circuitSession } = await import("./view.js");
    const wave = artifacts["waveform.json"]
      ? await readJSON(join(root, "waveform.json"), 64 * 1048576)
      : null;
    const adapter = circuitViewModel(
      {
        ...loaded,
        coverage,
        compiler: report.compiler,
        report,
        sourceStatus: "captured source",
      },
      wave,
      "connected-session",
    );
    await save("session.json", circuitSession(adapter, 0, "hex"));
    await writeJSON(join(root, "circuit.json"), report);
    return { ...report, path: join(root, "circuit.json") };
  });
}

export function compareNative(model, wave, expected) {
  if (!Array.isArray(expected) || !expected.length)
    return {
      ok: false,
      status: "inconclusive",
      message: "No correspondence cases supplied",
    };
  const trace = waveformModel(wave).simulate(),
    factor = scaleFs(wave.timescale);
  const initial = evaluateStep(model, initialSnapshot(model)),
    initializationMismatches = [];
  for (const [group, entries, prefix] of [
    ["state", model.state, "q_"],
    ["inputs", model.inputs, "i_"],
    ["outputsAfter", model.outputs, "o_"],
  ]) {
    for (const entry of entries) {
      const observed = trace[0]?.signals[`circuit_tb.${prefix}${entry.id}`];
      if (
        typeof observed !== "string" ||
        !/^[01]+$/.test(observed) ||
        BigInt("0b" + observed) !== BigInt(initial[group][entry.id])
      )
        initializationMismatches.push({
          subject: "initialization",
          signal: prefix + entry.id,
          expected: initial[group][entry.id],
          observed: observed ?? null,
        });
    }
  }
  if (trace[0]?.time !== "0")
    return {
      ok: false,
      status: "inconclusive",
      message: "Missing initialization observation",
      checked: 0,
      total: expected.length,
    };
  if (initializationMismatches.length)
    return {
      ok: false,
      status: "counterexample",
      subject: "initialization",
      mismatches: initializationMismatches,
      checked: 0,
      total: expected.length,
    };
  let index = 0;
  const checks = [];
  for (let test = 0; test < expected.length; test++) {
    const oldTime = BigInt(1 + test * 3) * 1000000n;
    while (
      index + 1 < trace.length &&
      BigInt(trace[index + 1].time) * factor <= oldTime
    )
      index++;
    const before = trace[index];
    const time = BigInt(3 + test * 3) * 1000000n;
    while (
      index + 1 < trace.length &&
      BigInt(trace[index + 1].time) * factor <= time
    )
      index++;
    const snapshot = trace[index],
      mismatches = [];
    if (!snapshot || BigInt(wave.events.at(-1).time) * factor < time)
      return {
        ok: false,
        status: "inconclusive",
        message: "Native trace ended before every correspondence sample",
        checked: test,
        total: expected.length,
      };
    for (const [group, entries, prefix, sample] of [
      ["state", model.state, "q_", before],
      ["inputs", model.inputs, "i_", snapshot],
      ["next", model.state, "q_", snapshot],
      ["outputsAfter", model.outputs, "o_", snapshot],
    ]) {
      for (const entry of entries) {
        const observed = sample.signals[`circuit_tb.${prefix}${entry.id}`],
          wanted = BigInt(expected[test][group][entry.id]);
        if (
          typeof observed !== "string" ||
          !/^[01]+$/.test(observed) ||
          BigInt("0b" + observed) !== wanted
        )
          mismatches.push({
            signal: prefix + entry.id,
            subject: group,
            expected: expected[test][group][entry.id],
            observed: observed ?? null,
          });
      }
    }
    checks.push({ case: test, verdict: mismatches.length ? "fail" : "pass" });
    if (mismatches.length)
      return {
        ok: false,
        status: "counterexample",
        case: test,
        snapshot: {
          state: expected[test].state,
          inputs: expected[test].inputs,
          previousClock: 0,
        },
        mismatches,
        checked: test + 1,
        total: expected.length,
        checks,
      };
  }
  return {
    ok: true,
    status: "simulation-only",
    checked: expected.length,
    total: expected.length,
    checks,
    scope:
      "Native settled Q/output samples for declared cases; not a formal equivalence/property proof",
  };
}

export async function readBundle(file, { checkCurrentSource = true } = {}) {
  const report = await readJSON(file, 4 * 1048576),
    root = dirname(resolve(file));
  if (
    report.format !== "chipsim-circuit-bundle" ||
    report.version !== 1 ||
    !report.artifacts ||
    typeof report.artifacts !== "object" ||
    Array.isArray(report.artifacts) ||
    Object.keys(report.artifacts).length > 32
  )
    throw new Error("Invalid connected circuit bundle");
  for (const name of [
    "source.json",
    "relation.json",
    "coverage.json",
    "relation.smt2",
    "generated.sv",
    "circuit.sv",
    "testbench.sv",
    "sim.project.json",
    "session.json",
  ])
    if (!report.artifacts[name])
      throw new Error("Incomplete circuit artifact closure: missing " + name);
  for (const [name, record] of Object.entries(report.artifacts)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || name === "..")
      throw new Error("Unsafe circuit artifact path");
    const path = join(root, name),
      info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error("Circuit artifacts must be regular captured files");
    const data = await readBounded(path, 128 * 1048576);
    if (digest(data) !== record.sha256 || data.length !== record.bytes)
      throw new Error("Stale/changed circuit artifact: " + name);
  }
  const identity = await compilerIdentity();
  if (identity.sha256 !== report.compiler?.sha256)
    throw new Error(
      "Stale circuit lowering: compiler identity changed; rebuild from source",
    );
  if (report.native) {
    if (!report.artifacts["native-artifacts.json"])
      throw new Error("Missing captured native artifact closure");
    const inventory = await readJSON(
      join(root, "native-artifacts.json"),
      4 * 1048576,
    );
    if (
      inventory.format !== "chipsim-artifact-manifest" ||
      inventory.version !== 1 ||
      !Array.isArray(inventory.artifacts) ||
      inventory.artifacts.length > 256
    )
      throw new Error("Invalid/bounded-out captured native artifact inventory");
    const nativeRoot = await realpath(join(root, "native"));
    for (const artifact of inventory.artifacts) {
      const path = join(nativeRoot, localPath(artifact.path));
      if ((await realpath(path)) !== path)
        throw new Error("Changed native artifact path: " + artifact.path);
      const bytes = await readBounded(path, 128 * 1048576);
      if (
        digest(bytes) !== artifact.payload?.sha256 ||
        bytes.length !== artifact.payload?.bytes
      )
        throw new Error("Stale/changed native artifact: " + artifact.path);
    }
  }
  const loaded = await readCircuit(join(root, "source.json"));
  if (loaded.source.sha256 !== report.source?.sha256)
    throw new Error("Circuit source fingerprint mismatch");
  let sourceStatus = "snapshot-only";
  const sourceStatuses = {
    model: "snapshot-only",
    rtl: "not-applicable",
    tool: "captured-identity",
  };
  if (report.lowering) {
    if (
      report.artifacts["lowered.json"]?.sha256 !== report.lowering.netlistSha256
    )
      throw new Error("Missing/changed captured HDL lowering netlist");
    const original = Buffer.from(report.lowering.sourceBytes || "", "base64");
    if (
      original.length > 1048576 ||
      digest(original) !== report.lowering.source.sha256
    )
      throw new Error("Captured original RTL fingerprint mismatch");
    const { circuitFromNetlist } = await import("./import.js");
    const rebuilt = circuitFromNetlist(
      await readJSON(join(root, "lowered.json"), 16 * 1048576),
      report.lowering.top,
      report.lowering.clock,
      Object.fromEntries(
        loaded.model.spec.inputs.map((input) => [input.id, input.initial]),
      ),
    );
    if (JSON.stringify(rebuilt.spec) !== JSON.stringify(loaded.model.spec))
      throw new Error(
        "Captured connected model does not match its HDL lowering",
      );
    sourceStatuses.rtl = "snapshot-only";
  }
  if (checkCurrentSource && report.lowering) {
    try {
      const rtl = await readBounded(report.lowering.source.path, 1048576);
      if (digest(rtl) !== report.lowering.source.sha256)
        throw new Error(
          "Stale HDL lowering: original RTL changed; re-import explicitly",
        );
      sourceStatuses.rtl = "current-source-matches";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      const tool = await readBounded(report.lowering.tool.path, 128 * 1048576);
      if (digest(tool) !== report.lowering.tool.sha256)
        throw new Error(
          "Stale HDL lowering: Yosys executable changed; re-import explicitly",
        );
      sourceStatuses.tool = "current-executable-matches";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (checkCurrentSource && typeof report.source.path === "string") {
    try {
      const current = await readBounded(
        report.source.path,
        circuitLimits.fileBytes,
      );
      if (digest(current) !== report.source.sha256)
        throw new Error(
          "Stale derived circuit: original source changed; rebuild explicitly",
        );
      sourceStatus = "current-source-matches";
      sourceStatuses.model = sourceStatus;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const coverage = checkCoverage(loaded.model);
  if (!coverage.ok)
    throw new Error(
      "Captured circuit does not pass current scoped coverage checks",
    );
  if (report.lowering)
    sourceStatus += ` · RTL ${sourceStatuses.rtl} · tool ${sourceStatuses.tool}`;
  return { ...loaded, report, coverage, sourceStatus, sourceStatuses, root };
}
