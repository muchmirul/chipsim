import {
  op,
  assign,
  signal,
  register,
  transition,
  and,
  input,
  widthFor,
} from "./shared.js";
export function fifo({ width, depth = 4 }) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 16)
    throw new Error("FIFO depth must be 1–16 words.");
  const slots = Array.from({ length: depth }, (_, index) =>
    register("word" + index, width),
  );
  const reset = [
    ...["level", "read_ptr", "write_ptr"].map((id) => assign("reg." + id, 0)),
    ...["word_out", "overflow", "underflow"].map((id) =>
      assign("signal." + id, 0),
    ),
    ...slots.map((slot) => assign("reg." + slot.id, 0)),
  ];
  const selectedWord = slots
    .slice(0, -1)
    .reduceRight(
      (result, slot, index) =>
        op("select", op("eq", "reg.read_ptr", index), "reg." + slot.id, result),
      "reg." + slots.at(-1).id,
    );
  const read = [
    assign("signal.word_out", selectedWord),
    assign("reg.read_ptr", op("mod", op("add", "reg.read_ptr", 1), depth)),
  ];
  const write = [
    ...slots.map((slot, index) =>
      assign(
        "reg." + slot.id,
        op(
          "select",
          op("eq", "reg.write_ptr", index),
          "signal.word_in",
          "reg." + slot.id,
        ),
      ),
    ),
    assign("reg.write_ptr", op("mod", op("add", "reg.write_ptr", 1), depth)),
  ];
  const rules = [
    transition(
      "fifo",
      op("eq", "signal.reset", 1),
      reset,
      "Reset clears FIFO and output",
      ["control", "storage"],
    ),
    transition(
      "fifo",
      and(
        op("eq", "signal.write", 1),
        op("eq", "signal.read", 1),
        op("gt", "reg.level", 0),
      ),
      [...read, ...write],
      "Read oldest word and accept new word; occupancy unchanged",
      ["input", "storage", "output", "control"],
    ),
    transition(
      "fifo",
      and(op("eq", "signal.write", 1), op("lt", "reg.level", depth)),
      [
        ...write,
        assign("reg.level", op("add", "reg.level", 1)),
        assign("signal.underflow", "signal.read"),
      ],
      "Accept write; empty simultaneous read raises underflow",
      ["input", "storage", "control"],
    ),
    transition(
      "fifo",
      and(op("eq", "signal.read", 1), op("gt", "reg.level", 0)),
      [...read, assign("reg.level", op("sub", "reg.level", 1))],
      "Read oldest word",
      ["storage", "output", "control"],
    ),
    transition(
      "fifo",
      op("eq", "signal.write", 1),
      [assign("signal.overflow", 1)],
      "Reject write to full FIFO; overflow pulse",
      ["input", "control"],
    ),
    transition(
      "fifo",
      op("eq", "signal.read", 1),
      [assign("signal.underflow", 1)],
      "Reject read from empty FIFO; underflow pulse",
      ["output", "control"],
    ),
  ];
  const clearFlags = [
      assign("signal.overflow", 0),
      assign("signal.underflow", 0),
    ],
    mask = 2 ** width - 1;
  const exampleInputs = [
    input(1, "write", 1),
    ...Array.from({ length: depth + 1 }, (_, i) =>
      input(i + 1, "word_in", (i + 1) & mask),
    ),
    input(depth + 2, "write", 0),
    input(depth + 2, "read", 1),
    input(2 * depth + 3, "read", 0),
  ];
  return {
    summary: `${depth}-word, ${width}-bit FIFO with data storage, occupancy, overflow, and underflow.`,
    scope:
      "A bounded FIFO data-path scenario with read/write requests per model tick. It does not infer peripheral bus transactions, DMA, silicon pipeline latency, or vendor-specific flag modes.",
    parameters: [],
    signals: [
      signal("write", 1, "input"),
      signal("read", 1, "input"),
      signal("reset", 1, "input"),
      signal("word_in", width, "input"),
      signal("word_out", width, "output"),
      signal("overflow", 1, "output"),
      signal("underflow", 1, "output"),
    ],
    registers: [
      register("level", widthFor(depth)),
      register("read_ptr", widthFor(depth - 1)),
      register("write_ptr", widthFor(depth - 1)),
      ...slots,
    ],
    nodes: [
      {
        id: "input",
        label: "Write port",
        kind: "external",
        signals: ["write", "word_in"],
      },
      {
        id: "storage",
        label: `${depth} × ${width}-bit storage`,
        registers: slots.map((slot) => slot.id),
      },
      {
        id: "control",
        label: "Pointers / occupancy",
        registers: ["level", "read_ptr", "write_ptr"],
      },
      {
        id: "output",
        label: "Read port / flags",
        signals: ["read", "word_out", "overflow", "underflow"],
      },
    ],
    edges: [
      { from: "input", to: "storage" },
      { from: "storage", to: "output" },
      { from: "control", to: "storage" },
      { from: "control", to: "output" },
    ],
    initialState: "setup",
    states: [
      {
        id: "setup",
        entry: reset,
        tick: clearFlags,
        transitions: rules,
        active: ["control"],
      },
      {
        id: "fifo",
        entry: [],
        tick: clearFlags,
        transitions: rules,
        active: ["control"],
      },
    ],
    assumptions: [
      "At most one read and one write are requested per normalized tick. RESET has priority and clears storage, pointers, output, and flags.",
      "A simultaneous read/write with available data reads the old word before writing the new word. This is accepted even when full; occupancy remains unchanged.",
      "A simultaneous read/write when empty rejects the read, pulses underflow, and stores the new word. There is no empty-FIFO bypass.",
      "Overflow and underflow are one-tick pulses. Rejected writes do not alter stored data; rejected reads hold the last output. These chosen semantics require review against the manual.",
    ],
    duration: 2 * depth + 8,
    exampleInputs,
    checks: [
      {
        name: "Stored words are read in order",
        ticks: depth + 1,
        inputs: [
          input(1, "write", 1),
          ...Array.from({ length: depth }, (_, i) =>
            input(i + 1, "word_in", (i + 1) & mask),
          ),
          input(depth + 1, "write", 0),
          input(depth + 1, "read", 1),
        ],
        expect: { "signal.word_out": 1 & mask, "reg.level": depth - 1 },
      },
      {
        name: "Write to full FIFO preserves data",
        ticks: depth + 1,
        inputs: [input(1, "write", 1), input(1, "word_in", 1 & mask)],
        expect: {
          "reg.level": depth,
          "signal.overflow": 1,
          "reg.word0": 1 & mask,
        },
      },
      {
        name: "Read from empty FIFO pulses underflow",
        ticks: 1,
        inputs: [input(1, "read", 1)],
        expect: { "reg.level": 0, "signal.underflow": 1, "signal.word_out": 0 },
      },
      {
        name: "Reset overrides transfer requests",
        ticks: 2,
        inputs: [
          input(1, "write", 1),
          input(1, "word_in", mask),
          input(2, "reset", 1),
          input(2, "read", 1),
        ],
        expect: {
          "reg.level": 0,
          "signal.word_out": 0,
          "reg.word0": 0,
          "signal.overflow": 0,
          "signal.underflow": 0,
        },
      },
      {
        name: "Full simultaneous transfer preserves occupancy",
        ticks: depth + 1,
        inputs: [
          input(1, "write", 1),
          input(1, "word_in", 1 & mask),
          input(depth + 1, "read", 1),
          input(depth + 1, "word_in", mask),
        ],
        expect: {
          "reg.level": depth,
          "signal.word_out": 1 & mask,
          "signal.overflow": 0,
          "reg.word0": mask,
        },
      },
      {
        name: "Empty simultaneous transfer has no bypass",
        ticks: 1,
        inputs: [
          input(1, "write", 1),
          input(1, "read", 1),
          input(1, "word_in", mask),
        ],
        expect: {
          "reg.level": 1,
          "signal.word_out": 0,
          "signal.underflow": 1,
          "reg.word0": mask,
        },
      },
    ],
  };
}
