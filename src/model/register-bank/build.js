import { sourcedModel } from "../builders/sourced.js";
import {
  op,
  assign,
  signal,
  register,
  input,
  and,
  widthFor,
} from "../builders/shared.js";
import { readRegisterRows } from "./read.js";

// Explicit developer-entered register rules; no PDF semantic inference.
export function buildRegisterBank(document, options) {
  const width = Number(options.width),
    rows = readRegisterRows(options.rows, width);
  const priority = options.hardwarePriority;
  if (!["before", "after"].includes(priority))
    throw new Error(
      "Choose hardware-set priority before or after the bus operation.",
    );
  const max = 2 ** width - 1,
    id = (row) => "value_" + row.name,
    set = (row) => "set_" + row.name;
  const eq = (a, b) => op("eq", a, b),
    choose = (c, a, b) => op("select", c, a, b);
  const accepted = (row) =>
    and("signal.valid", eq("signal.address", row.address));
  const read = and("signal.valid", op("not", "signal.write"));
  const base = (row) =>
    priority === "before"
      ? op("bitOr", "reg." + id(row), "signal." + set(row))
      : "reg." + id(row);
  const clear = (value, bits) => op("bitAnd", value, op("bitXor", bits, max));
  const effect = (row) => {
    const old = base(row),
      data = op("bitAnd", "signal.write_data", row.mask);
    const updated =
      row.mode === "rw"
        ? op("bitOr", clear(old, row.mask), data)
        : row.mode === "w1c"
          ? clear(old, data)
          : row.mode === "w1s"
            ? op("bitOr", old, data)
            : old;
    let result =
      row.mode === "rc"
        ? choose(
            and(accepted(row), op("not", "signal.write")),
            clear(old, row.mask),
            old,
          )
        : choose(and(accepted(row), "signal.write"), updated, old);
    if (priority === "after")
      result = op("bitOr", result, "signal." + set(row));
    return assign("reg." + id(row), choose("signal.reset", row.reset, result));
  };
  // Balanced trees keep the full 16-word bank below the expression-depth bound.
  const fold = (name, items) => {
    if (items.length === 1) return items[0];
    const mid = Math.ceil(items.length / 2);
    return op(
      name,
      fold(name, items.slice(0, mid)),
      fold(name, items.slice(mid)),
    );
  };
  const mapped = fold(
    "or",
    rows.map((row) => eq("signal.address", row.address)),
  );
  // Unique addresses ensure at most one selected term, so addition cannot overflow.
  const readValue = fold(
    "add",
    rows.map((row) => choose(eq("signal.address", row.address), base(row), 0)),
  );
  const step = [
    assign(
      "signal.valid",
      and(
        op("not", "signal.reset"),
        op("ne", "signal.request", "reg.previous_request"),
      ),
    ),
    assign("signal.error", and("signal.valid", op("not", mapped))),
    assign(
      "signal.read_data",
      choose(
        "signal.reset",
        0,
        choose(
          and(read, op("not", "signal.error")),
          readValue,
          "signal.read_data",
        ),
      ),
    ),
    ...rows.map(effect),
    assign("reg.previous_request", "signal.request"),
  ];
  const transition = (when, message) => ({
    to: "operating",
    when,
    message,
    actions: [],
    active: ["bus", "storage"],
    evidence: ["manual-excerpt"],
  });
  const transitions = [
    transition(
      "signal.reset",
      "Scenario reset dominates register access and hardware-set events.",
    ),
    transition(
      "signal.error",
      "Unmapped address rejected by the scenario adapter; retained read value and unrelated register storage preserved.",
    ),
    ...rows.map((row) =>
      transition(
        accepted(row),
        `Access ${row.name}: ${row.mode}, mask ${row.mask}; write selects the entered rule, read returns the pre-side-effect word${row.mode === "rc" ? " then clears selected bits" : ""}.`,
      ),
    ),
  ];
  const access = (tick, row, write, value, token) => [
    input(tick, "address", row.address),
    input(tick, "write", write),
    input(tick, "write_data", value),
    input(tick, "request", token),
  ];
  // Per-bit arithmetic oracle for acceptance expectations, independent of model expressions.
  const expectWrite = (row, data, hardware = 0) => {
    let value = 0;
    for (let bit = 0; bit < width; bit++) {
      const weight = 2 ** bit,
        masked = Math.floor(row.mask / weight) % 2,
        d = Math.floor(data / weight) % 2;
      const h = Math.floor(hardware / weight) % 2;
      let old = Math.floor(row.reset / weight) % 2;
      if (priority === "before") old = Math.max(old, h);
      if (masked) {
        if (row.mode === "rw") old = d;
        if (row.mode === "w1c" && d) old = 0;
        if (row.mode === "w1s" && d) old = 1;
      }
      if (priority === "after") old = Math.max(old, h);
      value += old * weight;
    }
    return value;
  };
  const checks = [
    {
      name: "Tick zero establishes register defaults and request baseline without executing a byte",
      ticks: 1,
      inputs: access(0, rows[0], 1, max, 1),
      expect: {
        ...Object.fromEntries(rows.map((row) => ["reg." + id(row), row.reset])),
        "signal.valid": 0,
      },
    },
    ...rows.flatMap((row) => {
      let cleared = 0;
      for (let bit = 0; bit < width; bit++)
        if (
          Math.floor(row.reset / 2 ** bit) % 2 &&
          !(row.mode === "rc" && Math.floor(row.mask / 2 ** bit) % 2)
        )
          cleared += 2 ** bit;
      const pattern = 0xa5a5a5a5 % 2 ** width;
      return [
        {
          name: row.name + " write obeys selected mode and mask",
          ticks: 1,
          inputs: access(1, row, 1, pattern, 1),
          expect: {
            ["reg." + id(row)]: expectWrite(row, pattern),
            "signal.valid": 1,
            "signal.error": 0,
          },
        },
        {
          name: row.name + " read returns pre-side-effect storage",
          ticks: 1,
          inputs: access(1, row, 0, 0, 1),
          expect: {
            "signal.read_data": row.reset,
            ["reg." + id(row)]: cleared,
          },
        },
        {
          name: row.name + " hardware-set/bus ordering is explicit",
          ticks: 1,
          inputs: [input(1, set(row), max), ...access(1, row, 1, max, 1)],
          expect: { ["reg." + id(row)]: expectWrite(row, max, max) },
        },
      ];
    }),
    {
      name: "Reset dominates simultaneous byte and hardware set; held request is not replayed",
      ticks: 3,
      inputs: [
        input(1, set(rows[0]), max),
        ...access(1, rows[0], 1, max, 1),
        input(1, "reset", 1),
        input(2, "reset", 0),
        input(2, set(rows[0]), 0),
      ],
      expect: {
        ...Object.fromEntries(rows.map((row) => ["reg." + id(row), row.reset])),
        "signal.valid": 0,
        "signal.read_data": 0,
      },
    },
  ];
  let missing = 0;
  while (rows.some((row) => row.address === missing)) missing++;
  checks.push({
    name: "Unmapped access rejects and held fields cannot replay",
    ticks: 2,
    inputs: [
      ...access(1, { address: missing }, 0, 0, 1),
      input(2, "address", rows[0].address),
    ],
    expect: {
      "signal.valid": 0,
      "signal.error": 0,
      "signal.read_data": 0,
      ...Object.fromEntries(rows.map((row) => ["reg." + id(row), row.reset])),
    },
  });
  checks.push({
    name: "Unmapped access reports tool error",
    ticks: 1,
    inputs: access(1, { address: missing }, 0, 0, 1),
    expect: { "signal.valid": 1, "signal.error": 1 },
  });
  const exampleInputs = rows.flatMap((row, index) => {
    const tick = index * 3 + 1;
    return [
      ...(row.mode === "rw"
        ? []
        : [input(tick, set(row), max), input(tick + 1, set(row), 0)]),
      ...access(tick + 1, row, 1, 0xa5a5a5a5 % 2 ** width, 1),
      ...access(tick + 2, row, 0, 0, 0),
    ];
  });
  return sourcedModel(document, options, {
    summary: `Entered ${width}-bit register bank with ${rows.length} addressed words and explicit access masks.`,
    scope:
      "Developer-entered register storage and side effects. No register map or semantics are inferred from PDF prose. Physical bus protocols, partial transfers, address alignment, aliases, peripheral datapaths, timing, reset domains, interrupts and electrical behavior require separate reviewed rules.",
    parameters: [],
    signals: [
      signal(
        "address",
        Math.max(
          8,
          widthFor(Math.max(...rows.map((row) => row.address), missing)),
        ),
        "input",
      ),
      signal("write_data", width, "input"),
      signal("write", 1, "input"),
      signal("request", 1, "input"),
      signal("reset", 1, "input"),
      signal("read_data", width, "output"),
      signal("valid", 1, "output"),
      signal("error", 1, "output"),
      ...rows.map((row) => ({
        ...signal(set(row), width, "input"),
        label: row.name + " synthetic set events",
      })),
    ],
    registers: [
      ...rows.map((row) => register(id(row), width, row.reset)),
      register("previous_request", 1),
    ],
    registerInterface: {
      kind: "toggle-word-v1",
      address: "address",
      writeData: "write_data",
      write: "write",
      request: "request",
      readData: "read_data",
      valid: "valid",
      error: "error",
    },
    registerMap: rows.map((row) => ({
      name: row.name,
      address: row.address,
      value: "reg." + id(row),
      access: ["ro", "rc"].includes(row.mode) ? "ro" : "rw",
      evidence: ["manual-excerpt"],
    })),
    nodes: [
      {
        id: "bus",
        label: "Abstract addressed word",
        kind: "external",
        signals: [
          "address",
          "write_data",
          "write",
          "request",
          "read_data",
          "valid",
          "error",
          "reset",
        ],
      },
      {
        id: "storage",
        label: "Named register storage / masks",
        registers: rows.map(id),
      },
      {
        id: "events",
        label: "Explicit synthetic hardware-set events",
        kind: "external",
        signals: rows.map(set),
      },
    ],
    edges: [
      { from: "bus", to: "storage" },
      { from: "events", to: "storage" },
      { from: "storage", to: "bus" },
    ],
    initialState: "initialize",
    states: [
      {
        id: "initialize",
        entry: [assign("reg.previous_request", "signal.request")],
        tick: step,
        transitions: [
          ...transitions,
          transition(
            true,
            "Register bank ready; initialized from entered values.",
          ),
        ],
      },
      {
        id: "operating",
        entry: [],
        tick: step,
        transitions,
        active: ["storage"],
      },
    ],
    duration: rows.length * 3 + 4,
    exampleInputs,
    checks,
    assumptions: [
      "Every entered address is a distinct scenario address, without implicit base offsets, alignment checks, byte lanes, aliases or address arithmetic. All words have the declared width. These values, modes, reset values and masks require review against the cited manual.",
      "A request-token change after tick zero performs one addressed word. Held tokens do not replay changed fields; tick zero initializes storage and the token baseline. Valid/error are tool status, not hardware ACK/NACK. Reset dominates accesses and hardware-set events and captures the current token baseline.",
      "rw replaces mask-selected bits; w1c clears mask-selected written ones; w1s sets mask-selected written ones. ro ignores writes and requires mask zero. rc ignores writes and clears mask-selected bits after returning the pre-clear word. Other bits retain their previous value.",
      `set_NAME inputs are synthetic word-wide bit-set events, not physical chip pins. Nonzero levels reassert on every model step. Hardware set runs ${priority} the bus operation; reset dominates both. With before ordering, reads include this tick's set bits; with after ordering, reads return the prior storage. No interrupt or physical peripheral event source is inferred.`,
      "Demonstration stimulus injects synthetic set bits for non-rw modes, writes an alternating pattern and reads each address. This is a selected test scenario, not autonomous device behavior.",
      ...rows.map(
        (row) =>
          `Entered register: ${row.name} address=${row.address} mode=${row.mode} reset=${row.reset} mask=${row.mask}.`,
      ),
    ],
  });
}
