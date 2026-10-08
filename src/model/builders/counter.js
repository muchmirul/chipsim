import {
  op,
  assign,
  signal,
  register,
  parameter,
  transition,
  input,
} from "./shared.js";
export function counter(options) {
  const { width, direction = "up", match = "repeat", value = 8 } = options,
    maxPeriod = Math.min(2 ** width, 0xffffffff);
  if (
    !["up", "down"].includes(direction) ||
    !["repeat", "halt"].includes(match)
  )
    throw new Error("Choose a valid counter direction and compare behavior.");
  if (!Number.isInteger(value) || value < 1 || value > maxPeriod)
    throw new Error(`Counter period must be 1–${maxPeriod}.`);
  const initial = direction === "up" ? 0 : op("sub", "param.period", 1),
    atMatch =
      direction === "up"
        ? op("ge", "reg.count", op("sub", "param.period", 1))
        : op("eq", "reg.count", 0);
  const reset = [assign("reg.count", initial), assign("signal.out", 0)];
  const resetTransition = transition(
    "counting",
    op("eq", "signal.reset", 1),
    reset,
    "Reset counter and output",
    ["inputs", "counter"],
  );
  const rules = [
    resetTransition,
    transition(
      match === "halt" ? "halted" : "counting",
      op("and", op("eq", "signal.enable", 1), atMatch),
      [
        ...(match === "repeat" ? [assign("reg.count", initial)] : []),
        assign("signal.out", op("bitXor", "signal.out", 1)),
      ],
      match === "halt"
        ? "Compare reached; output toggles and counter halts"
        : "Period elapsed; output toggles and counter reloads",
      ["counter", "compare", "pins"],
    ),
    transition(
      "counting",
      op("eq", "signal.enable", 1),
      [
        assign(
          "reg.count",
          op(direction === "up" ? "add" : "sub", "reg.count", 1),
        ),
      ],
      direction === "up" ? "Increment counter" : "Decrement counter",
      ["inputs", "counter"],
    ),
  ];
  const period = Math.min(maxPeriod, 3),
    testInitial = direction === "up" ? 0 : period - 1,
    held = direction === "up" ? 1 : period - 2;
  return {
    summary: `${width}-bit ${direction} counter with enable, reset, and ${match === "halt" ? "halt-on-compare" : "periodic output toggle"}.`,
    scope:
      "A selected counter/compare scenario. Register addresses, bus access, prescalers, interrupts, and physical clock timing are not reconstructed automatically.",
    parameters: [
      parameter("period", "Period · enabled ticks", value, 1, maxPeriod),
    ],
    signals: [
      signal("enable", 1, "input", 1),
      signal("reset", 1, "input"),
      signal("out", 1, "output"),
    ],
    registers: [register("count", width)],
    nodes: [
      {
        id: "inputs",
        label: "Enable / Reset",
        kind: "external",
        signals: ["enable", "reset"],
      },
      { id: "counter", label: `${width}-bit counter`, registers: ["count"] },
      {
        id: "compare",
        label: "Compare / reload",
        kind: "config",
        note: "Period is a runtime parameter",
      },
      { id: "pins", label: "Output", signals: ["out"] },
    ],
    edges: [
      { from: "inputs", to: "counter" },
      { from: "counter", to: "compare" },
      { from: "compare", to: "pins" },
    ],
    initialState: "setup",
    states: [
      {
        id: "setup",
        label: "Initialize scenario",
        entry: reset,
        tick: [],
        transitions: rules,
        active: ["inputs", "counter"],
      },
      {
        id: "counting",
        entry: [],
        tick: [],
        transitions: rules,
        active: ["counter"],
      },
      ...(match === "halt"
        ? [
            {
              id: "halted",
              entry: [],
              tick: [],
              transitions: [resetTransition],
              active: ["compare"],
            },
          ]
        : []),
    ],
    assumptions: [
      `A period of N represents N enabled model steps. The ${direction === "up" ? "up counter starts at zero and tests N−1 before its next increment" : "down counter starts at N−1 and tests zero before its next decrement"}.`,
      `Compare toggles OUT and ${match === "halt" ? "holds the compare count until RESET" : "reloads the counter for another period"}.`,
      `RESET has priority over ENABLE and compare. Disabling holds count and output. These selected rules require review against the manual.`,
    ],
    duration: Math.min(10000, Math.max(20, value * 2 + 4)),
    exampleInputs: [],
    checks: [
      {
        name: "Output toggles after one period",
        parameters: { period },
        ticks: period,
        expect: {
          "signal.out": 1,
          "reg.count":
            match === "halt"
              ? direction === "up"
                ? period - 1
                : 0
              : testInitial,
          state: match === "halt" ? "halted" : "counting",
        },
      },
      {
        name: "Disable holds counter",
        parameters: { period },
        ticks: period + 1,
        inputs: [input(2, "enable", 0)],
        expect: { "reg.count": held, "signal.out": 0 },
      },
      {
        name: "Reset clears output and reloads count",
        parameters: { period },
        ticks: period + 2,
        inputs: [input(period + 1, "reset", 1)],
        expect: {
          "signal.out": 0,
          "reg.count": testInitial,
          state: "counting",
        },
      },
      {
        name:
          match === "halt"
            ? "Halt preserves result"
            : "Second period toggles output back",
        parameters: { period },
        ticks: 2 * period,
        expect: {
          "signal.out": match === "halt" ? 1 : 0,
          "reg.count":
            match === "halt"
              ? direction === "up"
                ? period - 1
                : 0
              : testInitial,
        },
      },
    ],
  };
}
