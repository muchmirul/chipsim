import { instancesFor } from "./pins.js";
import { fold, pinId, tableId, bits } from "./shared.js";
import { inputVectors } from "./input-vectors.js";
import { retainedOutputs } from "./retained-read.js";
import { op, assign, signal, parameter } from "../builders/shared.js";
import { validateModel } from "../validate.js";
import { runChecks } from "../engine.js";

export function buildRetainedTable(document, table, { reservedIds = [] } = {}) {
  const {
    instances,
    shared = [],
    pinPages = [],
    indexed,
  } = instancesFor(document, table);
  const count = table.inputs.length,
    outCount = table.outputs.length;
  const labels = [...new Set(instances.flatMap((instance) => instance.labels))];
  if (labels.length > 32 || new Set(labels.map(pinId)).size !== labels.length)
    throw new Error(
      "Instantiated retained-state signals exceed bounds or collide after normalization.",
    );
  const signals = [],
    nodes = [],
    edges = [],
    initialize = [],
    actions = [],
    transitions = [];
  let outputBit = 0;
  instances.forEach((instance, instanceIndex) => {
    const ins = instance.labels.slice(0, count),
      outs = instance.labels.slice(count);
    instance.labels.forEach((label, index) => {
      if (!signals.some((s) => s.id === pinId(label)))
        signals.push({
          ...signal(pinId(label), 1, index < count ? "input" : "output"),
          label,
        });
    });
    const conditions = table.rows.map((row) =>
      fold(
        "and",
        row.inputs.flatMap((value, index) =>
          value === null
            ? []
            : [op("eq", "signal." + pinId(ins[index]), value)],
        ),
        true,
      ),
    );
    outs.forEach((label, column) => {
      initialize.push(
        assign(
          "signal." + pinId(label),
          op(
            "bitAnd",
            op("shiftRight", "param.initialOutputs", outputBit++),
            1,
          ),
        ),
      );
      // Full coverage and overlap agreement were checked for every prior state.
      // Each output may only retain itself or take a specified binary value.
      actions.push(
        assign(
          "signal." + pinId(label),
          table.rows.reduceRight(
            (rest, row, index) =>
              op(
                "select",
                conditions[index],
                row.outputs[column] === "hold"
                  ? "signal." + pinId(label)
                  : row.outputs[column],
                rest,
              ),
            "signal." + pinId(label),
          ),
        ),
      );
    });
    const inputNode = instance.key + "_inputs",
      storageNode = instance.key + "_storage";
    nodes.push(
      {
        id: inputNode,
        label: ins.join(" / "),
        kind: "external",
        signals: ins.map(pinId),
      },
      {
        id: storageNode,
        label:
          (indexed ? "Channel " + instance.key.slice(8) : "Table") +
          " · level-sensitive storage",
        kind: "datapath",
        signals: outs.map(pinId),
      },
    );
    edges.push({ from: inputNode, to: storageNode });
    if (!instanceIndex)
      table.rows.forEach((row, index) =>
        transitions.push({
          to: "run",
          when: conditions[index],
          actions: [],
          message: `Source row ${index + 1}: ${row.outputs.every((value) => value === "hold") ? "retain outputs" : "apply level-sensitive update"} for first instance; all ${instances.length} instance(s) evaluated.`,
          evidence: ["function-table"],
          active: [inputNode, storageNode],
        }),
      );
  });
  const vectorsAt = inputVectors(table, instances, shared);
  const checks = [];
  for (let value = 0; value < 2 ** count; value++)
    for (let held = 0; held < 2 ** outCount; held++) {
      const retained = bits(held, outCount),
        baseline = vectorsAt(table.idle, 0, false),
        current = vectorsAt(bits(value, count), 1, true);
      let initialOutputs = 0;
      const expect = {};
      instances.forEach((instance, index) => {
        retained.forEach(
          (bit, column) =>
            (initialOutputs += bit * 2 ** (index * outCount + column)),
        );
        retainedOutputs(table, current.vectors[index], retained).forEach(
          (bit, column) =>
            (expect["signal." + pinId(instance.labels[count + column])] = bit),
        );
      });
      checks.push({
        name: `Inputs ${value}, retained ${held}`,
        ticks: 1,
        parameters: { initialOutputs },
        inputs: [...baseline.inputs, ...current.inputs],
        expect,
      });
    }
  // Visit both directions so an enable can stay open across a data change and
  // then close before another change. These are chosen normalized stimuli.
  const combinations = Array.from({ length: 2 ** count }, (_, value) =>
    bits(value ^ (value >> 1), count),
  );
  const exampleInputs = vectorsAt(table.idle, 0, false).inputs;
  [...combinations, combinations[0], ...combinations.toReversed()].forEach(
    (values, index) =>
      exampleInputs.push(...vectorsAt(values, 2 + index * 2, true).inputs),
  );
  const active = nodes.map((node) => node.id);
  for (const transition of transitions) transition.active = active;
  const spec = {
    schemaVersion: 1,
    id: tableId(document, table, reservedIds, "level-table"),
    name: document.title + " · " + table.caption,
    fidelity: "behavioral",
    summary: `Level-sensitive binary updates and explicit retention derived from a complete function table; ${instances.length} instance(s).`,
    scope: `Only ${table.caption} on PDF page ${table.page}: specified binary level updates and literal no-change behavior, with ${instances.length} documented table instance(s). No clock-edge contract or package wiring is inferred. Initial output bits are configurable scenario values, not silicon power-on state. Physical timing, electrical behavior, and unmodeled chip features are omitted.`,
    parameters: [
      parameter(
        "initialOutputs",
        "Initial retained output bits",
        0,
        0,
        2 ** outputBit - 1,
      ),
    ],
    registers: [],
    signals,
    nodes,
    edges,
    initialState: "initialize",
    states: [
      {
        id: "initialize",
        label:
          "Initialize chosen state and immediately apply documented level rows",
        entry: [...initialize, ...actions],
        tick: actions,
        transitions,
        active,
      },
      {
        id: "run",
        label: "Evaluate level-sensitive function table",
        entry: [],
        tick: actions,
        transitions,
        active,
      },
    ],
    duration: 4 + combinations.length * 4,
    exampleInputs,
    sources: [
      {
        id: "manual",
        title: document.title,
        filename: document.filename,
        sha256: document.sha256,
      },
    ],
    evidence: [
      {
        id: "function-table",
        sourceId: "manual",
        page: table.page,
        quote: table.caption,
        claim:
          "Explicit binary/no-change rows define every input/prior-output combination, without missing rows or conflicting overlaps.",
      },
      ...pinPages.map((page, index) => ({
        id: "pin-instances-" + index,
        sourceId: "manual",
        page,
        quote: "Pin description",
        claim:
          "Numbered pin declarations establish these instances and shared input controls.",
      })),
    ],
    assumptions: [
      "initialOutputs supplies retained bits in instance order; the first output of the first instance is the least significant bit. These are scenario choices, not specified power-on values. Undriven inputs start at ideal digital zero.",
      "Documented level rows act immediately at tick zero and later ticks. Explicit no change retains only that output's prior value. No omitted input combination is filled with hold, and no clock edge is invented.",
      "All input events at one normalized tick precede evaluation together. Closing an enable while data also changes uses the documented closed-level row and retains the previously observed state. This ideal sampling choice does not predict physical setup/hold violations, hazards, metastability, or delays.",
      "The default input sweep is chosen stimulus, not an internal clock. Separate package instances are included only when consistent indexed pin declarations identify them. Generic unindexed headings model one table instance; other package latches and their wiring remain outside scope. Multi-word headings join whitespace in model identifiers.",
    ],
    checks,
    sourceTable: {
      compiler: "retained-function-table-v1",
      page: table.page,
      caption: table.caption,
      inputs: table.inputs,
      outputs: table.outputs,
      rows: table.rows,
      symbolRows: table.rawRows,
      matrix: table.matrix,
      instances: instances.map((instance) => instance.labels),
    },
  };
  validateModel(spec, [document]);
  const results = runChecks(spec);
  if (results.some((check) => !check.passed))
    throw new Error("Compiled retained-state table acceptance checks failed.");
  return {
    spec,
    checks: results,
    method: "level-sensitive function table",
    table,
  };
}
