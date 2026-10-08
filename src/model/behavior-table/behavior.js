import {
  assign,
  op,
  signal,
  register,
  parameter,
  input,
  widthFor,
} from "../builders/shared.js";

const pin = (name) => "pin_" + name.toLowerCase();
const node = (name) => "state_" + name;
const all = (terms) => terms.reduce((a, b) => op("and", a, b), true);
const word = (values) =>
  values.reduce((sum, bit, at) => sum + bit * 2 ** at, 0);

export function behaviorFromTable(table) {
  const { inputs, outputs, states, rules, cases } = table;
  const initialCode = states.reduceRight(
    (value, state, code) =>
      op("select", op("eq", "param.initialState", state), code, value),
    0,
  );
  const transitions = (from) =>
    rules
      .filter((row) => from === null || row.from === "*" || row.from === from)
      .map((row) => ({
        to: node(row.to),
        when: all([
          ...(from === null && row.from !== "*"
            ? [op("eq", "param.initialState", row.from)]
            : []),
          ...row.inputs.flatMap((bit, at) =>
            bit === "X"
              ? []
              : [op("eq", "signal." + pin(inputs[at]), Number(bit))],
          ),
        ]),
        actions: [
          assign("reg.behavior_state", states.indexOf(row.to)),
          ...row.outputs.flatMap((bit, at) =>
            bit === "="
              ? []
              : [assign("signal." + pin(outputs[at]), Number(bit))],
          ),
        ],
        message: `Entered row ${row.number}: ${row.text}`,
        evidence: ["manual-excerpt"],
        active: ["inputs", "controller", node(row.to), "pins"],
      }));
  const exampleInputs = [];
  for (let value = 0; value < 2 ** inputs.length; value++) {
    const gray = value ^ (value >> 1);
    inputs.forEach((name, at) =>
      exampleInputs.push(
        input(value + 1, pin(name), (gray >> (inputs.length - 1 - at)) & 1),
      ),
    );
  }
  const behavior = {
    summary: `Developer-authored behavior table: ${states.length} state(s), ${inputs.length} binary inputs, ${outputs.length} binary outputs.`,
    scope:
      "Only the explicitly entered rules are modeled. These rules were authored by a developer, not inferred from the PDF. One table step executes per normalized tick after initialization; clock edges, reset priority, package channels, register/bus protocols, timing, and other behavior are not implied by names. Source quotes establish textual provenance, not automatic verification of the entered interpretation.",
    parameters: [
      {
        id: "initialState",
        label: "Initial behavior state",
        type: "enum",
        options: states,
        default: states[0],
      },
      parameter(
        "initialOutputs",
        "Initial output bits · first output in bit 0",
        0,
        0,
        2 ** outputs.length - 1,
      ),
    ],
    signals: [
      ...inputs.map((name) => ({
        ...signal(pin(name), 1, "input"),
        label: name,
      })),
      ...outputs.map((name) => ({
        ...signal(pin(name), 1, "output"),
        label: name,
      })),
    ],
    registers: [
      {
        ...register("behavior_state", widthFor(states.length - 1)),
        label: "Behavior state code",
      },
    ],
    nodes: [
      {
        id: "inputs",
        label: "Entered inputs",
        kind: "external",
        signals: inputs.map(pin),
      },
      {
        id: "controller",
        label: "Behavior table",
        registers: ["behavior_state"],
      },
      ...states.map((state, code) => ({
        id: node(state),
        label: state,
        note: "State code " + code,
      })),
      { id: "pins", label: "Entered outputs", signals: outputs.map(pin) },
    ],
    edges: [
      { from: "inputs", to: "controller" },
      ...states.flatMap((state) => [
        { from: "controller", to: node(state) },
        { from: node(state), to: "pins" },
      ]),
    ],
    initialState: "initialize",
    states: [
      {
        id: "initialize",
        label: "Initialize chosen state and output scenario",
        entry: [
          assign("reg.behavior_state", initialCode),
          ...outputs.map((name, at) =>
            assign(
              "signal." + pin(name),
              op("bitAnd", op("shiftRight", "param.initialOutputs", at), 1),
            ),
          ),
        ],
        tick: [],
        transitions: transitions(null),
        active: ["inputs", "controller", "pins"],
      },
      ...states.map((state) => ({
        id: node(state),
        label: state,
        entry: [],
        tick: [],
        transitions: transitions(state),
        active: ["controller", node(state), "pins"],
      })),
    ],
    duration: Math.max(8, 2 ** inputs.length + 2),
    exampleInputs,
    assumptions: [
      "Tick zero establishes the configurable initial state and output bits without taking a behavior row. From tick one, exactly one row executes after all input events at that tick; held inputs can advance the state again on the next tick. A signal named CLK is an ordinary input unless the developer explicitly represents clock history in the entered states.",
      "Input/output patterns follow the declared pin order from left to right. X is an input wildcard; = retains that output's previous bit. Unspecified combinations reject creation; no implicit hold, priority, clock, or reset rule is supplied.",
      "State codes: " +
        states.map((state, code) => `${code} = ${state}`).join("; "),
      "Input order: " +
        inputs.join(" ") +
        "; output order: " +
        outputs.join(" ") +
        ". Initial output bit 0 is the first output column.",
      ...rules.map(
        (row) => "Developer-entered row " + row.number + ": " + row.text,
      ),
      "Acceptance cases exhaust declared states, input combinations, and retained output bits against the entered rows. They test generated-rule consistency, not whether the developer interpreted the PDF correctly. Independent hardware behavior checks are still needed for device fidelity.",
      "The demonstration Gray-code sweep drives inputs once per normalized step; it is a stimulus example and does not establish that every named state is reachable in a particular device.",
    ],
    checks: cases.map((item) => ({
      name: `${item.state}, inputs ${item.inputs.join("")}, prior ${item.retained.join("")}: row ${item.row}`,
      parameters: {
        initialState: item.state,
        initialOutputs: word(item.retained),
      },
      ticks: 1,
      inputs: inputs.map((name, at) => input(1, pin(name), item.inputs[at])),
      expect: {
        state: node(item.expected.state),
        "reg.behavior_state": states.indexOf(item.expected.state),
        ...Object.fromEntries(
          outputs.map((name, at) => [
            "signal." + pin(name),
            item.expected.outputs[at],
          ]),
        ),
      },
    })),
  };
  return behavior;
}
