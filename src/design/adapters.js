import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readProject, runHDL } from "../hdl/run.js";
import { debugTools } from "../hdl/debug/tools.js";
import { runModel } from "../agent/model.js";
import { runAgentProgram } from "../agent/program.js";
import { prepareProject } from "../agent/project.js";
import { readWaveform, readComparisonTrace } from "../hdl/io.js";
import { compareBehavior } from "../hdl/compare.js";
import { files, json, localPath, fileDigest } from "./store.js";
import { execute } from "./process.js";
import { parseXunit } from "./xunit.js";
import { physicalChecks, physicalReportFile } from "./physical.js";
import { mcpResult } from "./mcp-result.js";
import { referencePath } from "../documents/references.js";

const native = new Set([
  "hdl",
  "model",
  "program",
  "document",
  "waveform",
  "compare",
]);
const builtinModels = new Set(["pio", "pru", "flexio", "udb", "xmos", "etpu"]);
const tool =
  (command, args = ["--version"]) =>
  async () => [[command, args]];
export const adapters = {
  hdl: {
    tools: async (task, root) => {
      const p = await readProject(join(root, localPath(task.options?.project)));
      const names =
        p.language === "verilog"
          ? [
              ["iverilog", ["-V"]],
              ["vvp", ["-V"]],
            ]
          : [["ghdl", ["--version"]]];
      if (task.options.debug === false) return names;
      const chain = (await debugTools())[p.language];
      if (!chain.available) throw new Error(chain.reason);
      return names.map(([cmd, args]) => [chain.commands[cmd], args]);
    },
  },
  model: {
    tools: async () => [
      ["pdftotext", ["-v"]],
      ["pdfinfo", ["-v"]],
    ],
  },
  program: {
    tools: async () => [
      ["pdftotext", ["-v"]],
      ["pdfinfo", ["-v"]],
    ],
  },
  document: {
    tools: async () => [
      ["pdftotext", ["-v"]],
      ["pdfinfo", ["-v"]],
    ],
  },
  waveform: { tools: async () => [] },
  compare: { tools: async () => [] },
  fusesoc: { tools: tool("fusesoc") },
  peakrdl: {
    tools: async (t) => [
      ["peakrdl", ["--version"]],
      [t.options?.python || "python3", ["--version"]],
    ],
  },
  verilator: {
    tools: async () => [
      ["verilator", ["--version"]],
      ["make", ["--version"]],
      ["c++", ["--version"]],
    ],
  },
  cocotb: {
    tools: async (t) => [
      ["make", ["--version"]],
      ["cocotb-config", ["--version"]],
      ...(t.options?.simulator === "icarus"
        ? [
            ["iverilog", ["-V"]],
            ["vvp", ["-V"]],
          ]
        : [["verilator", ["--version"]]]),
    ],
  },
  sby: {
    tools: async (t) => [
      ["sby", ["--version"]],
      ["yosys", ["-V"]],
      ...(t.options?.solvers || ["z3"]).map((c) => [c, ["--version"]]),
    ],
  },
  eqy: {
    tools: async () => [
      ["eqy", ["--version"]],
      ["yosys", ["-V"]],
    ],
  },
  orfs: {
    tools: async () => [
      ["make", ["--version"]],
      ["yosys", ["-V"]],
      ["openroad", ["-version"]],
      ["klayout", ["-v"]],
    ],
  },
  firmware: {
    tools: async (t) => [
      [t.options?.compiler || "riscv64-unknown-elf-gcc", ["--version"]],
      [
        t.options?.objcopy ||
          (t.options?.compiler || "riscv64-unknown-elf-gcc").replace(
            /gcc$/,
            "objcopy",
          ),
        ["--version"],
      ],
    ],
  },
  renode: { tools: tool("renode") },
  "openroad-mcp": {
    tools: async (task) => {
      const requests = task.options?.requests || [];
      const commands = requests
        .filter((r) => r.name === "create_interactive_session")
        .map((r) => r.arguments?.command?.[0] || "openroad");
      if (
        requests.some((r) =>
          ["interactive_openroad_query", "interactive_openroad_exec"].includes(
            r.name,
          ),
        ) &&
        !commands.length
      )
        commands.push("openroad");
      return [
        ["openroad-mcp", ["--help"]],
        ...[...new Set(commands)].map((c) => [c, ["-version"]]),
      ];
    },
  },
  command: {
    tools: async (t) => [
      [t.options?.command || "false", t.options?.versionArgs || ["--version"]],
    ],
  },
};
export async function adapterResources(task, root) {
  if (task.adapter !== "program") return [];
  const { parseProgram } = await import("../program/parse.js");
  const manifest = (
    await import("../../docs/references/manifest.json", {
      with: { type: "json" },
    })
  ).default;
  const program = parseProgram(
    await boundedText(join(root, localPath(task.options.program))),
  );
  return [
    ...new Set(
      program.guides.map((g) => g.document).filter((d) => d !== "manual"),
    ),
  ].map((id) => {
    const doc = manifest.documents.find((d) => d.id === id);
    if (!doc) throw new Error("Unknown programming guide " + id);
    return {
      path: "_chipsim_resources/" + doc.path,
      origin: referencePath(doc),
    };
  });
}
export async function adapterIdentity(task) {
  if (task.adapter !== "hdl" || task.options?.debug === false) return {};
  const toolchain = await debugTools(),
    entries = [];
  for (const language of ["verilog", "vhdl"])
    for (const [name, path] of Object.entries(
      toolchain[language].commands || {},
    ))
      entries.push({ language, name, path, ...(await fileDigest(path)) });
  return { instrumentation: "chipsim-1", entries };
}

export async function adapterInputs(task, root) {
  const o = task.options || {},
    paths = [];
  const add = (p) => {
    if (p) paths.push(localPath(p));
  };
  if (task.adapter === "hdl") {
    add(o.project);
    const p = await readProject(join(root, o.project));
    for (const f of [...p.sources, ...p.assets, ...p.includeDirs])
      add(relative(root, join(p.base, f)));
  } else if (task.adapter === "program" || task.adapter === "model") {
    if (!builtinModels.has(o.model)) add(o.model);
    add(o.program);
    add(o.project);
    add(o.params);
    add(o.inputs);
  } else if (task.adapter === "document") add(o.manual);
  else if (task.adapter === "waveform") add(o.waveform);
  else if (task.adapter === "compare") {
    add(o.left);
    add(o.right);
    add(o.map);
  } else
    for (const key of ["config", "script", "rdl", "makefile", "linker"])
      add(o[key]);
  return paths.filter((p) => !(task.bindings || []).some((b) => b.path === p));
}

export function payloadKind(path, adapter) {
  if (path.endsWith("debug.json"))
    return adapter === "hdl" ? "hdl-debug" : "program-debug";
  if (path.endsWith("session.json")) return "model-session";
  if (path.endsWith("waveform.json")) return "waveform";
  if (path.endsWith("trace.json")) return "model-trace";
  if (path.endsWith("comparison.json")) return "comparison";
  return (
    {
      ".vcd": "waveform-vcd",
      ".fst": "waveform-fst",
      ".sv": "rtl",
      ".v": ["orfs", "eqy"].includes(adapter) ? "netlist" : "rtl",
      ".h": "firmware-header",
      ".elf": "firmware",
      ".gds": "layout",
      ".oas": "layout",
      ".odb": "physical-database",
      ".def": "physical-design",
      ".spef": "parasitics",
      ".sdc": "constraints",
      ".lib": "timing-library",
      ".lef": "physical-library",
      ".rpt": "report",
      ".xml": "test-report",
      ".lyrdb": "drc-report",
      ".lvsdb": "lvs-report",
      ".log": "log",
      ".jsonl": "event-stream",
    }[extname(path)] || "file"
  );
}
export function capabilities(kind) {
  return (
    {
      "hdl-debug": ["hdl-events", "sources", "signals"],
      waveform: ["waveform"],
      "waveform-vcd": ["waveform"],
      "model-session": ["model-session"],
      layout: ["external-layout"],
      "program-debug": ["report"],
      report: ["report"],
      comparison: ["report"],
      "test-report": ["report"],
    }[kind] || ["metadata"]
  );
}
const check = (name, verdict, scope, evidence = [], assumptions = []) => ({
  name,
  verdict,
  scope,
  evidence,
  assumptions,
});

// Native reports remain the authority. Exit status alone never implies a
// property proof, test-suite pass, or successful physical verification.
export async function normalizeChecks(
  task,
  workspace,
  execution,
  inputs = task.inputs,
) {
  const result = [],
    adapter = task.definition.adapter,
    o = task.definition.options || {};
  const success = execution.ok;
  result.push(
    check("execution", success ? "pass" : "fail", "Process execution only", [
      "execution.json",
    ]),
  );
  if (execution.nativeResult) {
    const r = execution.nativeResult;
    const label =
      adapter === "compare"
        ? "comparison"
        : adapter === "document"
          ? "preparation"
          : adapter === "waveform"
            ? "import"
            : "simulation";
    result.push(
      check(
        label,
        r.ok === false || r.comparison?.match === false ? "fail" : "pass",
        adapter === "compare"
          ? "Explicit mapped waveform comparison"
          : "Declared experiment and capture boundary",
        ["native-result.json"],
      ),
    );
    for (const [i, c] of (r.checks || []).entries())
      result.push(
        check(
          "acceptance-" + i,
          c.passed ? "pass" : "fail",
          c.name || "Model acceptance case",
          ["native-result.json"],
        ),
      );
  }
  if (adapter === "cocotb") {
    const path = o.results || "results.xml";
    try {
      const xml = await boundedText(join(workspace, localPath(path)));
      const tests = parseXunit(xml);
      let passed = 0,
        failed = 0,
        skipped = 0;
      for (const [i, entry] of tests.entries()) {
        const fail = entry.verdict === "fail",
          skip = entry.verdict === "inconclusive";
        if (fail) failed++;
        else if (skip) skipped++;
        else if (!skip) passed++;
        result.push(check("test-" + i, entry.verdict, entry.name, [path]));
      }
      result.push(
        check(
          "tests",
          success && passed && !failed && !skipped
            ? "pass"
            : failed
              ? "fail"
              : "inconclusive",
          "Executed cocotb test suite",
          [path],
        ),
      );
    } catch (e) {
      result.push(check("tests", "inconclusive", e.message, [path]));
    }
  }
  if (adapter === "sby" || adapter === "eqy") {
    const dir = o.output || "out";
    let verdict = "inconclusive";
    const evidence = [];
    if (adapter === "sby") {
      try {
        const statuses = (await files(join(workspace, dir))).filter(
          (p) => p === "status" || p.endsWith("/status"),
        );
        const values = [];
        for (const p of statuses) {
          values.push(
            (await boundedText(join(workspace, dir, p))).trim().split(/\s/)[0],
          );
          evidence.push(join(dir, p));
        }
        verdict = values.includes("FAIL")
          ? "fail"
          : success && values.length && values.every((v) => v === "PASS")
            ? "pass"
            : "inconclusive";
      } catch {}
    } else {
      try {
        await readFile(join(workspace, dir, "PASS"));
        verdict = success ? "pass" : "inconclusive";
        evidence.push(join(dir, "PASS"));
      } catch {}
      if (verdict !== "pass") {
        try {
          await readFile(join(workspace, dir, "FAIL"));
          evidence.push(join(dir, "FAIL"));
        } catch {}
      }
      // EQY FAIL also means inability to prove; do not call it a counterexample.
    }
    result.push(
      check(
        adapter === "sby" ? "formal" : "equivalence",
        verdict,
        o.scope ||
          "Tasks/properties selected by the captured formal configuration",
        evidence,
        o.assumptions || [],
      ),
    );
  }
  if (adapter === "orfs")
    result.push(...(await physicalChecks(task, workspace, execution, inputs)));
  if (adapter === "openroad-mcp") {
    let verdict = "inconclusive",
      detail =
        "All declared OpenROAD-MCP calls returned complete successful responses; no hardware property is implied";
    try {
      const r = await json(join(workspace, "mcp-results.json"));
      if (
        r.format !== "chipsim-mcp-results" ||
        r.version !== 1 ||
        !Array.isArray(r.results)
      )
        throw new Error("Invalid MCP results");
      verdict = r.results.some((r) => r.verdict === "fail")
        ? "fail"
        : success &&
            r.complete &&
            r.results.length &&
            r.results.every((r) => r.verdict === "pass")
          ? "pass"
          : "inconclusive";
    } catch (e) {
      detail += ": " + e.message;
    }
    result.push(
      check("mcp", verdict, detail, ["mcp-session.jsonl", "mcp-results.json"]),
    );
  }
  for (const spec of task.definition.checks || []) {
    const path = localPath(spec.path);
    let verdict = "inconclusive",
      detail = spec.scope || spec.name;
    try {
      const report = await json(join(workspace, path));
      const value = String(spec.field || "")
        .split(".")
        .filter(Boolean)
        .reduce((v, key) => v?.[key], report);
      if (spec.operator === "eq")
        verdict = value === spec.value ? "pass" : "fail";
      else if (
        ["lte", "gte"].includes(spec.operator) &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        typeof spec.value === "number"
      )
        verdict = (
          spec.operator === "lte" ? value <= spec.value : value >= spec.value
        )
          ? "pass"
          : "fail";
      if (value === undefined || !success) verdict = "inconclusive";
    } catch (e) {
      detail += ": " + e.message;
    }
    result.push(
      check(spec.name, verdict, detail, [path], spec.assumptions || []),
    );
  }
  return result;
}
async function boundedText(path) {
  const { readBounded } = await import("../agent/io.js");
  return (await readBounded(path, 8 * 1048576)).toString("utf8");
}

export async function executeAdapter(task, context) {
  const { workspace, signal, log, owners } = context,
    def = task.definition,
    o = def.options || {},
    adapter = def.adapter;
  const path = (p) => join(workspace, localPath(p));
  if (native.has(adapter)) {
    let r;
    if (adapter === "hdl")
      r = (
        await runHDL(path(o.project), path("out"), {
          debug: o.debug !== false,
          signal,
          owners,
        })
      ).result;
    if (adapter === "model")
      r = await runModel(path(o.model), path(o.project), path("out"), {
        ...o,
        params: o.params && path(o.params),
        inputs: o.inputs && path(o.inputs),
      });
    if (adapter === "program")
      r = await runAgentProgram(path(o.program), path("out"), {
        ...o,
        guideRoot: path("_chipsim_resources"),
        model: builtinModels.has(o.model) ? o.model : path(o.model),
        project: o.project && path(o.project),
      });
    if (adapter === "document")
      r = await prepareProject(path(o.manual), path("out"));
    if (adapter === "waveform") {
      await mkdir(path("out"));
      await writeFile(
        path("out/waveform.json"),
        JSON.stringify(await readWaveform(path(o.waveform))),
      );
      r = { ok: true };
    }
    if (adapter === "compare") {
      const comparison = compareBehavior(
        await readComparisonTrace(path(o.left)),
        await readComparisonTrace(path(o.right)),
        await json(path(o.map)),
      );
      await mkdir(path("out"));
      await writeFile(path("out/comparison.json"), JSON.stringify(comparison));
      r = { ok: comparison.match, comparison };
    }
    await writeFile(path("native-result.json"), JSON.stringify(r, null, 2));
    return {
      ok: r.ok !== false,
      nativeResult: r,
      reason: r.ok === false ? "native checks failed" : null,
    };
  }
  const expand = (s) =>
    String(s)
      .replaceAll("{workspace}", workspace)
      .replaceAll("{out}", path("out"));
  const invoke = async (command, args, env = {}) => {
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string"))
      throw new Error("Tool arguments must be a string array");
    return execute(command, args.map(expand), {
      cwd: workspace,
      signal,
      timeoutMs: def.timeoutMs,
      env: Object.fromEntries(
        Object.entries({
          ...(task.profile.env || {}),
          ...(o.env || {}),
          ...env,
        }).map(([k, v]) => [k, expand(v)]),
      ),
      log,
      owners,
    });
  };
  if (adapter === "openroad-mcp")
    return mcpSession(
      task.profile.command ||
        o.command ||
        task.tools[0]?.path ||
        "openroad-mcp",
      task,
      context,
    );
  if (task.profile.command || o.command || o.args) {
    const command =
      task.profile.command ||
      o.command ||
      task.tools[0]?.path ||
      task.tools[0]?.command;
    return invoke(command, o.args || task.profile.args || []);
  }
  const cmd = task.tools[0]?.path || task.tools[0]?.command;
  if (adapter === "fusesoc")
    return invoke(cmd, [
      "--cores-root=.",
      "run",
      "--setup",
      "--build-root=out",
      "--target=" + (o.target || "default"),
      o.core,
    ]);
  if (adapter === "peakrdl") {
    await mkdir(path("out"));
    for (const [exporter, output] of [
      ["regblock", "out"],
      ["c-header", "out/registers.h"],
      ["ip-xact", "out/registers.xml"],
    ]) {
      const r = await invoke(cmd, [
        exporter,
        o.rdl,
        "-o",
        output,
        ...(exporter === "regblock"
          ? ["--module-name", "registers", "--package-name", "registers_pkg"]
          : []),
        ...(o.exportArgs?.[exporter] || []),
      ]);
      if (!r.ok) return r;
    }
    return invoke(task.tools[1].path, [
      fileURLToPath(
        new URL("../../scripts/design-registers.py", import.meta.url),
      ),
      o.rdl,
      "out/registers.json",
    ]);
  }
  if (adapter === "verilator") {
    await mkdir(path("out"), { recursive: true });
    const rtl = task.inputs
      .filter((f) => /\.(v|sv)$/.test(f.path))
      .map((f) => f.path);
    const r = await invoke(cmd, [
      "--binary",
      "--timing",
      "--trace",
      "--Mdir",
      "out/obj",
      "--top-module",
      o.top,
      ...rtl,
      ...(o.flags || []),
    ]);
    if (!r.ok || o.buildOnly) return r;
    return invoke(path("out/obj/V" + o.top), o.runArgs || []);
  }
  if (adapter === "cocotb")
    return invoke(cmd, [
      "-f",
      o.makefile || "Makefile",
      "SIM=" + (o.simulator || "verilator"),
      ...(o.makeArgs || []),
    ]);
  if (adapter === "sby" || adapter === "eqy")
    return invoke(cmd, ["-d", o.output || "out", o.config, ...(o.tasks || [])]);
  if (adapter === "orfs") {
    if (!o.flow)
      throw new Error(
        "ORFS requires options.flow pointing to a locked flow directory",
      );
    const result = await invoke(cmd, [
      "-C",
      o.flow,
      "DESIGN_CONFIG=" + path(o.config),
      "WORK_HOME=" + workspace,
      "RESULTS_DIR=" + path("out/results"),
      "REPORTS_DIR=" + path("out/reports"),
      "LOG_DIR=" + path("out/logs"),
      "OBJECTS_DIR=" + path("out/objects"),
      "YOSYS_EXE=" + task.tools[1].path,
      "OPENROAD_EXE=" + task.tools[2].path,
      "KLAYOUT_CMD=" + task.tools[3].path,
      ...(o.stages || ["finish"]),
    ]);
    const reports = Object.fromEntries(
      ["drc", "lvs"]
        .filter((k) => o.reports?.[k])
        .map((k) => [k, path(o.reports[k].path)]),
    );
    if (Object.keys(reports).length && !signal?.aborted) {
      await writeFile(
        path("chipsim-physical-request.json"),
        JSON.stringify(reports),
      );
      const reader = await invoke(task.tools[3].path, [
        "-b",
        "-r",
        fileURLToPath(
          new URL("../../scripts/design-klayout.py", import.meta.url),
        ),
        "-rd",
        "request=" + path("chipsim-physical-request.json"),
        "-rd",
        "result=" + path(physicalReportFile),
      ]);
      if (!reader.ok)
        result.reportError = reader.reason || "KLayout report reader failed";
    }
    return result;
  }
  if (adapter === "firmware") {
    await mkdir(path("out"));
    const result = await invoke(cmd, [
      ...task.inputs
        .filter((f) => /\.(c|S|s)$/.test(f.path))
        .map((f) => f.path),
      ...(o.flags || []),
      ...(o.linker ? ["-T", o.linker] : []),
      "-Wl,-Map,out/firmware.map",
      "-o",
      "out/firmware.elf",
    ]);
    if (!result.ok) return result;
    for (const [format, file] of [
      ["binary", "firmware.bin"],
      ["verilog", "firmware.hex"],
    ]) {
      const converted = await invoke(task.tools[1].path, [
        "-O",
        format,
        "out/firmware.elf",
        "out/" + file,
      ]);
      if (!converted.ok) return converted;
    }
    return result;
  }
  if (adapter === "renode")
    return invoke(cmd, ["--disable-xwt", "--console", o.script]);
  throw new Error("Configure options.command and args for this task");
}

async function mcpSession(command, task, { workspace, signal, log, owners }) {
  // A finite JSON-RPC transcript gives interactive agent work an immutable
  // attempt boundary. Requests are explicit inputs; responses are evidence.
  const { spawn } = await import("node:child_process");
  const { processIdentity } = await import("./process.js");
  const { atomic } = await import("./store.js");
  const options = task.definition.options || {};
  const expand = (value) => {
    if (typeof value === "string")
      return value
        .replaceAll("{workspace}", workspace)
        .replaceAll("{out}", join(workspace, "out"));
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, expand(v)]),
      );
    return value;
  };
  const requests = expand(options.requests || []);
  if (!requests.length || requests.length > 256)
    throw new Error("MCP session requires 1–256 explicit requests");
  if (
    requests.some(
      (r) =>
        typeof r.name !== "string" ||
        !r.name ||
        !r.arguments ||
        typeof r.arguments !== "object" ||
        Array.isArray(r.arguments),
    )
  )
    throw new Error("MCP requests require a tool name and arguments object");
  await mkdir(join(workspace, "out"), { recursive: true });
  await mkdir(dirname(log), { recursive: true });
  const output = await open(log, "a");
  let writes = Promise.resolve();
  const child = spawn(
    command,
    expand(options.args || task.profile.args || []),
    {
      cwd: workspace,
      env: {
        ...process.env,
        ...expand({ ...task.profile.env, ...options.env }),
      },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffer = "",
    transcript = "",
    bytes = 0,
    seq = 0,
    fatal;
  const waiting = new Map();
  const results = [];
  let complete = false;
  const fail = (e) => {
    fatal ||= e;
    for (const waiter of waiting.values()) waiter.reject(e);
    waiting.clear();
  };
  child.on("error", fail);
  child.on("close", () => fail(new Error("MCP server closed")));
  child.stdin.on("error", fail);
  const closed = new Promise((done) => child.once("close", done));
  const record = (direction, message) => {
    const line = JSON.stringify({ direction, message }) + "\n";
    bytes += Buffer.byteLength(line);
    if (bytes > 8 * 1048576) throw new Error("MCP transcript limit");
    transcript += line;
  };
  child.stdout.on("data", (b) => {
    if (Buffer.byteLength(buffer) + b.length + bytes > 8 * 1048576) {
      fail(new Error("MCP response limit"));
      return;
    }
    buffer += b;
    let n;
    while ((n = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      try {
        const r = JSON.parse(line);
        if (r.jsonrpc !== "2.0")
          throw new Error("Invalid MCP JSON-RPC version");
        record("response", r);
        const waiter = waiting.get(r.id);
        if (waiter) {
          if (!("result" in r) && !("error" in r))
            throw new Error("Missing MCP result");
          waiting.delete(r.id);
          waiter.resolve(r);
        }
      } catch (error) {
        fail(new Error("Invalid MCP JSON-RPC response: " + error.message));
      }
    }
  });
  child.stderr.on("data", (b) => {
    bytes += b.length;
    if (bytes > 8 * 1048576) fail(new Error("MCP output limit"));
    else writes = writes.then(() => output.write(b)).catch(fail);
  });
  const stop = () => {
    try {
      process.kill(
        process.platform === "win32" ? child.pid : -child.pid,
        "SIGKILL",
      );
    } catch {}
    fail(new Error("MCP cancelled"));
  };
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, task.definition.timeoutMs || 300000);
  async function send(method, params) {
    if (fatal) throw fatal;
    const message = { jsonrpc: "2.0", id: ++seq, method, params };
    record("request", message);
    const pending = new Promise((resolve, reject) =>
      waiting.set(seq, { resolve, reject }),
    );
    child.stdin.write(JSON.stringify(message) + "\n");
    return pending;
  }
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const owner = await processIdentity(child.pid);
    if (owner && owners) await atomic(join(owners, child.pid + ".json"), owner);
    if (signal?.aborted) throw new Error("MCP cancelled");
    const initialized = await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "chipsim", version: "1" },
    });
    if (
      initialized.error ||
      !initialized.result?.protocolVersion ||
      !initialized.result?.capabilities
    )
      throw new Error("MCP initialization failed");
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };
    record("request", notification);
    child.stdin.write(JSON.stringify(notification) + "\n");
    for (const request of requests) {
      const r = await send("tools/call", request);
      const normalized = mcpResult(r);
      results.push({
        index: results.length,
        name: request.name,
        ...normalized,
      });
      if (normalized.verdict !== "pass")
        return {
          ok: false,
          reason: normalized.error || "MCP response did not establish success",
        };
    }
    complete = true;
    return { ok: true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    stop();
    await closed;
    await writes;
    await output.close();
    await writeFile(join(workspace, "mcp-session.jsonl"), transcript);
    await writeFile(
      join(workspace, "mcp-results.json"),
      JSON.stringify(
        {
          format: "chipsim-mcp-results",
          version: 1,
          complete,
          requested: requests.length,
          results,
        },
        null,
        2,
      ),
    );
  }
}
