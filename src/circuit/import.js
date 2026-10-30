import { writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  readBounded,
  readJSON,
  createDirectory,
  writeJSON,
} from "../agent/io.js";
import { processRun } from "../hdl/run.js";
import { digest } from "../hdl/io.js";
import { executable } from "../design/project.js";
import { compileCircuit } from "./model.js";
import { buildCircuit } from "./files.js";

// Consume Yosys's actual lowered connections, not source-name/behavior guesses.
// Only this reviewed binary gate/flop subset is accepted; every other cell fails.
export function circuitFromNetlist(netlist, top, clock, initial) {
  const module = netlist.modules?.[top];
  if (!module || Object.keys(module.memories || {}).length)
    throw new Error(
      "No supported flattened module, or unsupported memory state",
    );
  const ports = Object.entries(module.ports || {}),
    inputs = [],
    outputs = [],
    state = [],
    nodes = [],
    connections = [],
    drivers = new Map(),
    mapping = { state: {}, nodes: {} };
  if (!initial || typeof initial !== "object" || Array.isArray(initial))
    throw new Error("Declare every input's initial binary value explicitly");
  const define = (bit, source) => {
    if (
      typeof bit !== "number" ||
      !Number.isSafeInteger(bit) ||
      bit < 0 ||
      drivers.has(bit)
    )
      throw new Error(
        "Unsupported net bit or multiple drivers in lowered circuit",
      );
    drivers.set(bit, source);
  };
  for (const [id, port] of ports) {
    if (
      !["input", "output"].includes(port.direction) ||
      port.signed ||
      port.upto ||
      port.offset
    )
      throw new Error(
        "Only unsigned zero-based descending input/output ports are supported; no inout/resolved buses",
      );
    if (port.direction === "input") {
      if (!Object.hasOwn(initial, id))
        throw new Error("Missing explicit initial input " + id);
      inputs.push({ id, width: port.bits.length, initial: initial[id] });
      port.bits.forEach((bit, index) =>
        define(bit, { from: "input." + id, slice: [index, index] }),
      );
    } else outputs.push({ id, width: port.bits.length });
  }
  if (Object.keys(initial).length !== inputs.length)
    throw new Error("Initial inputs contain unknown/duplicate declarations");
  const clockPort = module.ports[clock];
  if (
    !clockPort ||
    clockPort.direction !== "input" ||
    clockPort.bits.length !== 1
  )
    throw new Error("Clock must name a declared one-bit input");
  const initialBits = new Map();
  for (const net of Object.values(module.netnames || {})) {
    if (net.attributes?.init === undefined) continue;
    const value = net.attributes.init;
    if (
      typeof value !== "string" ||
      value.length !== net.bits.length ||
      !/^[01]+$/.test(value)
    )
      throw new Error(
        "Unsupported unknown/nonbinary initial state in lowered HDL",
      );
    [...value].reverse().forEach((bit, index) => {
      const netBit = net.bits[index];
      if (initialBits.has(netBit) && initialBits.get(netBit) !== bit)
        throw new Error("Conflicting HDL initial-state declarations");
      initialBits.set(netBit, bit);
    });
  }
  const cells = Object.entries(module.cells || {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (cells.length > 192)
    throw new Error(
      "Lowered HDL exceeds the reviewed gate/flop import bound (192 cells)",
    );
  const constant = (bits) => ({ bits, width: 1 }),
    ref = (name) => ({ ref: name }),
    unary = (op, value) => ({ op, args: [value] }),
    binary = (op, a, b) => ({ op, args: [a, b] });
  const gate = {
    $_BUF_: () => ref("A"),
    $_NOT_: () => unary("not", ref("A")),
    $_AND_: () => binary("and", ref("A"), ref("B")),
    $_OR_: () => binary("or", ref("A"), ref("B")),
    $_XOR_: () => binary("xor", ref("A"), ref("B")),
    $_XNOR_: () => unary("not", binary("xor", ref("A"), ref("B"))),
    $_NAND_: () => unary("not", binary("and", ref("A"), ref("B"))),
    $_NOR_: () => unary("not", binary("or", ref("A"), ref("B"))),
    $_ANDNOT_: () => binary("and", ref("A"), unary("not", ref("B"))),
    $_ORNOT_: () => binary("or", ref("A"), unary("not", ref("B"))),
    $_MUX_: () => ({ op: "mux", args: [ref("S"), ref("B"), ref("A")] }),
  };
  const pending = [];
  for (const [name, cell] of cells) {
    const pins = cell.connections;
    if (cell.type === "$_DFF_P_") {
      if (
        pins.C?.length !== 1 ||
        pins.C[0] !== clockPort.bits[0] ||
        pins.D?.length !== 1 ||
        pins.Q?.length !== 1
      )
        throw new Error("Unsupported multiple/gated clock or flop connection");
      const bit = pins.Q[0],
        start = initialBits.get(bit);
      if (start === undefined)
        throw new Error(
          "Every retained HDL state bit needs explicit binary initialization; missing " +
            name,
        );
      const id = "R" + state.length;
      state.push({
        id,
        width: 1,
        initial: Number(start),
        ports: { d: 1 },
        rules: [
          {
            id: "clocked",
            priority: 0,
            reason: "load",
            when: constant(1),
            value: ref("d"),
          },
        ],
      });
      define(bit, { from: "state." + id });
      pending.push({ bit: pins.D[0], to: `state.${id}.d` });
      mapping.state[id] = {
        cell: name,
        qBit: bit,
        nets: Object.entries(module.netnames || {})
          .filter(([, net]) => net.bits.includes(bit))
          .map(([net, value]) => ({
            name: net,
            width: value.bits.length,
            index:
              (value.offset || 0) +
              (value.upto
                ? value.bits.length - 1 - value.bits.indexOf(bit)
                : value.bits.indexOf(bit)),
            visible: !value.hide_name,
            initialized: value.attributes?.init !== undefined,
          })),
      };
    } else {
      const factory = gate[cell.type];
      if (!factory)
        throw new Error(
          "Unsupported lowered cell " +
            cell.type +
            " (latches, async flops, memories and black boxes are not imported)",
        );
      if (!pins.Y || pins.Y.length !== 1)
        throw new Error("Unsupported gate output width");
      const id = "G" + nodes.length,
        portWidths = {};
      for (const [port, bits] of Object.entries(pins)) {
        if (port === "Y") continue;
        if (bits.length !== 1) throw new Error("Unsupported gate input width");
        portWidths[port] = 1;
        pending.push({ bit: bits[0], to: `node.${id}.${port}` });
      }
      nodes.push({ id, width: 1, ports: portWidths, expression: factory() });
      define(pins.Y[0], { from: "node." + id });
      mapping.nodes[id] = { cell: name, type: cell.type };
    }
  }
  const source = (bit) => {
    if (typeof bit === "string") {
      if (!/^[01]$/.test(bit))
        throw new Error(
          "Unsupported X/Z/unavailable source bit in lowered HDL",
        );
      const id = "Constant" + bit;
      if (!nodes.some((node) => node.id === id))
        nodes.push({
          id,
          width: 1,
          ports: {},
          expression: constant(Number(bit)),
        });
      return { from: "node." + id };
    }
    const found = drivers.get(bit);
    if (!found) throw new Error("Undeclared/undriven lowered net " + bit);
    return found;
  };
  for (const entry of pending)
    connections.push({ ...source(entry.bit), to: entry.to });
  for (const output of outputs) {
    const bits = module.ports[output.id].bits;
    if (bits.length === 1)
      connections.push({ ...source(bits[0]), to: "output." + output.id });
    else {
      function combine(bits, suffix) {
        if (bits.length === 1) return { ...source(bits[0]), width: 1 };
        const groups = [];
        for (let i = 0; i < bits.length; i += 16)
          groups.push(bits.slice(i, i + 16));
        const pieces =
          groups.length === 1
            ? bits.map((bit) => ({ ...source(bit), width: 1 }))
            : groups.map((group, index) =>
                combine(group, suffix + "_" + index),
              );
        const id = "Bus" + outputs.indexOf(output) + suffix,
          ports = {};
        pieces.forEach((piece, index) => {
          ports["b" + index] = piece.width;
          const { width, ...wire } = piece;
          connections.push({ ...wire, to: `node.${id}.b${index}` });
        });
        nodes.push({
          id,
          width: bits.length,
          ports,
          expression: {
            op: "concat",
            args: pieces.map((_, index) => ref("b" + index)).reverse(),
          },
        });
        return { from: "node." + id, width: bits.length };
      }
      const { width, ...wire } = combine(bits, "");
      connections.push({ ...wire, to: "output." + output.id });
    }
  }
  const spec = {
    format: "chipsim-circuit",
    version: 1,
    id: "imported_" + top,
    name: "HDL connected circuit: " + top,
    description:
      "Derived from Yosys binary gate/flop connections. Register labels map to retained RTL state bits; reset behavior remains in the connected logic, not inferred from signal names.",
    clock: { signal: clock, edge: "rising" },
    inputs,
    state,
    nodes,
    outputs,
    connections,
  };
  compileCircuit(spec);
  return { spec, mapping };
}

export function originalWrapper(spec, mapping, top) {
  const stateTargets = {},
    paths = {};
  for (const entry of spec.state) {
    const net = mapping.state[entry.id].nets
      .filter(
        (net) =>
          net.visible &&
          /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(
            net.name,
          ),
      )
      .sort(
        (a, b) =>
          Number(b.initialized) - Number(a.initialized) ||
          a.name.localeCompare(b.name),
      )[0];
    if (!net)
      throw new Error(
        "Original RTL state has no supported hierarchical verification path: " +
          entry.id,
      );
    paths[entry.id] =
      `u_chipsim_design.${net.name}${net.width === 1 ? "" : "[" + net.index + "]"}`;
    stateTargets[entry.id] = "dut." + paths[entry.id];
  }
  const name = "chipsim_import_wrapper",
    ports = [
      ...spec.inputs.map(
        (entry) => `input wire [${entry.width - 1}:0] i_${entry.id}`,
      ),
      ...spec.state.map((entry) => `output wire [0:0] q_${entry.id}`),
      ...spec.outputs.map(
        (entry) => `output wire [${entry.width - 1}:0] o_${entry.id}`,
      ),
    ];
  if (top === name)
    throw new Error("Reserved wrapper name; choose another source module name");
  const text = [
    `module ${name}(${ports.join(",\n")});`,
    `${top} u_chipsim_design(${[...spec.inputs.map((entry) => `.${entry.id}(i_${entry.id})`), ...spec.outputs.map((entry) => `.${entry.id}(o_${entry.id})`)].join(", ")});`,
    ...spec.state.map((entry) => `assign q_${entry.id} = ${paths[entry.id]};`),
    "endmodule",
    "",
  ].join("\n");
  return { name, text, stateTargets };
}

export async function importCircuit(
  file,
  destination,
  { top, clock, initial, cases, yosys = "yosys", signal } = {},
) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,22}$/.test(top || "") || !clock || !initial)
    throw new Error(
      "HDL import requires --top (1..23 identifier characters), --clock and --initial INPUTS.json",
    );
  const bytes = await readBounded(file, 1048576),
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    /`(?!timescale\b|default_nettype\b)[A-Za-z_]/.test(text) ||
    /\$readmem[bh]\b/.test(text)
  )
    throw new Error(
      "HDL import accepts one self-contained compilation unit; macros/includes and external memory-file initialization are unsupported",
    );
  const inputs = await readJSON(initial, 1048576),
    command = await executable(yosys);
  if (!command)
    throw new Error(
      "Yosys is unavailable; configure an existing executable with --yosys PATH",
    );
  return createDirectory(destination, async (root) => {
    await writeFile(join(root, "source.sv"), bytes, { flag: "wx" });
    const script = `read_verilog -sv source.sv\nhierarchy -check -top ${top}\nproc\nflatten\ncheck -assert\ntechmap\nsimplemap\nopt_clean\ncheck -assert\nwrite_json netlist.json\n`;
    await writeFile(join(root, "lower.ys"), script, { flag: "wx" });
    const version = await processRun(command, ["-V"], {
      cwd: root,
      timeoutMs: 10000,
      signal,
    });
    const execution = await processRun(
      command,
      ["-Q", "-T", "-s", "lower.ys"],
      {
        cwd: root,
        timeoutMs: 30000,
        signal,
        capturePaths: [
          { path: join(root, "netlist.json"), limit: 16 * 1048576 },
        ],
      },
    );
    await writeJSON(join(root, "diagnostics.json"), { version, execution });
    const report = {
      format: "chipsim-circuit-import",
      version: 1,
      ok: false,
      status: "inconclusive",
      source: {
        path: resolve(file),
        sha256: digest(bytes),
        bytes: bytes.length,
      },
      top,
      clock,
      tool: {
        path: command,
        sha256: digest(await readBounded(command, 128 * 1048576)),
        version: version.stdout.trim(),
      },
      execution,
      scope:
        "Actual Yosys lowering of one self-contained unsigned binary RTL unit; only reviewed gates and positive-edge DFFs with explicit initial state. No whole-chip/physical equivalence claim.",
    };
    try {
      if (!version.ok || !execution.ok)
        throw new Error("Yosys lowering failed; inspect diagnostics.json");
      const netBytes = await readBounded(
          join(root, "netlist.json"),
          16 * 1048576,
        ),
        { spec, mapping } = circuitFromNetlist(
          JSON.parse(netBytes.toString("utf8")),
          top,
          clock,
          inputs,
        );
      await writeJSON(join(root, "model.json"), spec);
      const lowering = {
        source: report.source,
        sourceBytes: bytes.toString("base64"),
        tool: report.tool,
        netlistSha256: digest(netBytes),
        mapping,
        script,
        top,
        clock,
      };
      const verify = cases || compileCircuit(spec).domainBits <= 12;
      report.bundle = await buildCircuit(
        join(root, "model.json"),
        join(root, "connected"),
        {
          lowering,
          loweredNetlist: netBytes,
          ...(verify
            ? {
                operation: "verify",
                rtl: join(root, "source.sv"),
                nativeWrapper: originalWrapper(spec, mapping, top),
                cases,
                signal,
              }
            : {}),
        },
      );
      report.ok = report.bundle.ok;
      report.status = report.bundle.status;
      report.originalCorrespondence = report.bundle.correspondence || {
        status: "inconclusive",
        message:
          "Derived model exceeds 12 domain bits; supply --cases to check original RTL on explicit snapshots",
      };
      report.tui = report.bundle.tui;
    } catch (error) {
      report.error = error.message;
    }
    await writeJSON(join(root, "import.json"), report);
    return { ...report, path: join(root, "import.json") };
  });
}
