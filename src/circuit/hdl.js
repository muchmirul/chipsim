import { verilog, literal, fields } from "./expression.js";

export const rtlName = (kind, id) =>
  ({ input: "i_", state: "q_", node: "n_", output: "o_" })[kind] + id;
const range = (bits) => `[${bits - 1}:0]`;
export function generatedHDL(model) {
  const names = (connection) => {
    const link = model.connections.get(connection),
      source = rtlName(link.source.kind, link.source.id);
    return link.width === link.source.width
      ? source
      : `${source}[${link.slice[0]}:${link.slice[1]}]`;
  };
  const ports = [
    ...model.inputs.map(
      (input) => `input wire ${range(input.width)} i_${input.id}`,
    ),
    ...model.state.map(
      (state) => `output reg ${range(state.width)} q_${state.id}`,
    ),
    ...model.outputs.map(
      (output) => `output wire ${range(output.width)} o_${output.id}`,
    ),
  ];
  const lines = [
    "// ChipSim connected circuit v1: unsigned binary vectors, one rising clock.",
    "// State initialization is an authored scenario, not a physical power-up guarantee.",
    "`timescale 1ns/1ps",
    "module chipsim_circuit(",
    ports.join(",\n"),
    ");",
  ];
  for (const node of model.nodes)
    lines.push(
      `wire ${range(node.width)} n_${node.id};`,
      `assign n_${node.id} = ${verilog(node.expression, (port) => names(`node.${node.id}.${port}`))};`,
    );
  for (const output of model.outputs)
    lines.push(`assign o_${output.id} = ${names(`output.${output.id}`)};`);
  for (const state of model.state) {
    lines.push(
      `initial q_${state.id} = ${state.width}'h${state.initial.toString(16)};`,
      `always @(posedge i_${model.clock}) begin`,
    );
    state.rules.forEach((rule, index) => {
      const read = (port) => names(`state.${state.id}.${port}`);
      lines.push(
        `  ${index ? "else " : ""}if (${verilog(rule.when, read)}) q_${state.id} <= ${rule.hold ? `q_${state.id}` : verilog(rule.value, read)}; // ${rule.id}: ${rule.reason}, priority ${rule.priority}`,
      );
    });
    // Emission requires complete guard coverage; there is no implicit hold row.
    lines.push("end");
  }
  lines.push("endmodule", "");
  return lines.join("\n");
}

export function validateStimulus(model, supplied) {
  fields(supplied, ["format", "version", "duration", "events"]);
  if (
    supplied.format !== "chipsim-circuit-stimulus" ||
    supplied.version !== 1 ||
    !Number.isInteger(supplied.duration) ||
    supplied.duration < 1 ||
    supplied.duration > 10000 ||
    !Array.isArray(supplied.events) ||
    supplied.events.length > 10000
  )
    throw new Error(
      "Expected circuit stimulus v1: duration 1..10000 ns and at most 10000 explicit events",
    );
  const inputs = new Map(model.inputs.map((input) => [input.id, input]));
  const collisions = new Set();
  const events = supplied.events
    .map((event) => {
      fields(event, ["tick", "signal", "value"]);
      const input = inputs.get(event.signal),
        key = `${event.tick}:${event.signal}`;
      if (
        !input ||
        !Number.isInteger(event.tick) ||
        event.tick < 1 ||
        event.tick > supplied.duration ||
        collisions.has(key)
      )
        throw new Error(
          "Circuit events must drive declared inputs once per signal/time at 1..duration; initialization is declared in the source",
        );
      collisions.add(key);
      return {
        ...event,
        width: input.width,
        value: literal(event.value, input.width),
      };
    })
    .sort((a, b) => a.tick - b.tick);
  return { duration: supplied.duration, events };
}

function benchStart(model, moduleName = "chipsim_circuit") {
  return [
    "`timescale 1ns/1ps",
    "module circuit_tb;",
    ...model.inputs.map((input) => `reg ${range(input.width)} i_${input.id};`),
    ...model.state.map((state) => `wire ${range(state.width)} q_${state.id};`),
    ...model.outputs.map(
      (output) => `wire ${range(output.width)} o_${output.id};`,
    ),
    `${moduleName} dut(${[...model.inputs.map((input) => `i_${input.id}`), ...model.state.map((state) => `q_${state.id}`), ...model.outputs.map((output) => `o_${output.id}`)].map((name) => `.${name}(${name})`).join(", ")});`,
    "initial begin",
    '  $dumpfile("trace.vcd");',
    "  $dumpvars(0, circuit_tb);",
    ...model.inputs.map(
      (input) =>
        `  i_${input.id} = ${input.width}'h${input.initial.toString(16)};`,
    ),
  ];
}
export function stimulusBench(model, stimulus) {
  const lines = benchStart(model);
  let tick = 0;
  const groups = Map.groupBy(stimulus.events, (event) => event.tick);
  for (const [time, events] of groups) {
    if (time > tick) lines.push(`  #${time - tick};`);
    tick = time;
    for (const event of events.filter((event) => event.signal !== model.clock))
      lines.push(
        `  i_${event.signal} = ${event.width}'h${event.value.toString(16)};`,
      );
    // The declared sampled inputs settle through the acyclic network before
    // the clock event at this timestamp. This is a digital scheduling choice.
    if (events.some((event) => event.signal === model.clock))
      lines.push("  #0;");
    for (const event of events.filter((event) => event.signal === model.clock))
      lines.push(
        `  i_${event.signal} = ${event.width}'h${event.value.toString(16)};`,
      );
  }
  if (stimulus.duration > tick) lines.push(`  #${stimulus.duration - tick};`);
  lines.push("  #1; $finish;", "end", "endmodule", "");
  return lines.join("\n");
}

export function correspondenceBench(model, cases, wrapper) {
  const lines = benchStart(model, wrapper?.name);
  lines.push(
    "  #1; // permit authored initialization to settle before injecting arbitrary old states",
  );
  for (const snapshot of cases) {
    // Injecting arbitrary states is a verification harness only. Circuit RTL
    // never gains a new write port or routable state-input path.
    lines.push(`  i_${model.clock} = 0;`);
    for (const input of model.inputs.filter(
      (input) => input.id !== model.clock,
    ))
      lines.push(
        `  i_${input.id} = ${input.width}'h${literal(snapshot.inputs[input.id], input.width).toString(16)};`,
      );
    for (const state of model.state)
      lines.push(
        `  ${wrapper?.stateTargets[state.id] || "dut.q_" + state.id} = ${state.width}'h${literal(snapshot.state[state.id], state.width).toString(16)};`,
      );
    lines.push(
      `  #1; i_${model.clock} = 1;`,
      "  #1; // sample settled Q/outputs",
      "  #1; // keep the sample timestamp separate from the next case's injection",
    );
  }
  lines.push("  #1; $finish;", "end", "endmodule", "");
  return lines.join("\n");
}

export function hdlManifest() {
  return {
    format: "chipsim-hdl-project",
    version: 1,
    name: "Connected circuit",
    language: "verilog",
    standard: "2012",
    sources: ["circuit.sv", "testbench.sv"],
    top: "circuit_tb",
    waveform: "trace.vcd",
    timeoutMs: 30000,
  };
}

export function symbolicSMT(model) {
  const symbol = (kind, id) => rtlName(kind, id);
  function expr(value, read) {
    if (value.kind === "constant") return `(_ bv${value.bits} ${value.width})`;
    if (value.kind === "ref") return read(value.ref);
    const args = value.args.map((arg) => expr(arg, read));
    if (value.kind === "slice")
      return `((_ extract ${value.high} ${value.low}) ${args[0]})`;
    if (value.kind === "concat")
      return args.reduce((left, right) => `(concat ${left} ${right})`);
    if (value.kind === "mux")
      return `(ite (= ${args[0]} #b1) ${args[1]} ${args[2]})`;
    if (["eq", "ult"].includes(value.kind))
      return `(ite (${value.kind === "eq" ? "=" : "bvult"} ${args.join(" ")}) #b1 #b0)`;
    return `(${{ not: "bvnot", and: "bvand", or: "bvor", xor: "bvxor", add: "bvadd", sub: "bvsub" }[value.kind]} ${args.join(" ")})`;
  }
  const read = (destination, post = false) => {
    const link = model.connections.get(destination),
      name = symbol(link.source.kind, link.source.id);
    const selected =
      post && link.source.kind === "state"
        ? "next_q_" + link.source.id
        : post && link.source.kind === "node"
          ? "post_" + name
          : name;
    return link.width === link.source.width
      ? selected
      : `((_ extract ${link.slice[0]} ${link.slice[1]}) ${selected})`;
  };
  const lines = [
    "; ChipSim circuit v1 symbolic one-event relation, not a proof result.",
    "(set-logic QF_BV)",
    "(declare-fun previous_clock () (_ BitVec 1))",
  ];
  for (const [kind, entries] of [
    ["input", model.inputs],
    ["state", model.state],
  ])
    for (const entry of entries)
      lines.push(
        `(declare-fun ${symbol(kind, entry.id)} () (_ BitVec ${entry.width}))`,
      );
  lines.push(
    `(define-fun rising () Bool (and (= previous_clock #b0) (= i_${model.clock} #b1)))`,
  );
  for (const node of model.nodes)
    lines.push(
      `(define-fun n_${node.id} () (_ BitVec ${node.width}) ${expr(node.expression, (port) => read(`node.${node.id}.${port}`))})`,
    );
  for (const state of model.state) {
    const port = (name) => read(`state.${state.id}.${name}`);
    // Coverage check establishes that this final fallback is unreachable at an edge.
    let next = `q_${state.id}`;
    for (const rule of [...state.rules].reverse())
      next = `(ite (= ${expr(rule.when, port)} #b1) ${rule.hold ? `q_${state.id}` : expr(rule.value, port)} ${next})`;
    lines.push(
      `(define-fun next_q_${state.id} () (_ BitVec ${state.width}) (ite rising ${next} q_${state.id}))`,
    );
    const guards = state.rules.map(
      (rule) => `(= ${expr(rule.when, port)} #b1)`,
    );
    lines.push(
      `(define-fun covered_${state.id} () Bool ${guards.length === 1 ? guards[0] : "(or " + guards.join(" ") + ")"})`,
    );
  }
  for (const node of model.nodes)
    lines.push(
      `(define-fun post_n_${node.id} () (_ BitVec ${node.width}) ${expr(node.expression, (port) => read(`node.${node.id}.${port}`, true))})`,
    );
  for (const output of model.outputs)
    lines.push(
      `(define-fun o_${output.id} () (_ BitVec ${output.width}) ${read(`output.${output.id}`)})`,
      `(define-fun post_o_${output.id} () (_ BitVec ${output.width}) ${read(`output.${output.id}`, true)})`,
    );
  const covered = model.state.map((state) => "covered_" + state.id);
  lines.push(
    `(define-fun rules_complete () Bool ${covered.length === 1 ? covered[0] : "(and " + covered.join(" ") + ")"})`,
    "; This query checks rule completeness only; equal-priority agreement is checked separately by ChipSim's BDD checker.",
    "(assert (not rules_complete))",
    "(check-sat)",
    "",
  );
  return lines.join("\n");
}
