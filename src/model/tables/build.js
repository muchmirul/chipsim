import { instancesFor } from "./pins.js";
import { op, assign, signal, input } from "../builders/shared.js";
import { validateModel } from "../validate.js";
import { runChecks } from "../engine.js";
const fold = (operator, values, empty) =>
  !values.length
    ? empty
    : values.length === 1
      ? values[0]
      : op(
          operator,
          fold(operator, values.slice(0, Math.ceil(values.length / 2)), empty),
          fold(operator, values.slice(Math.ceil(values.length / 2)), empty),
        );
const id = (label) => "pin_" + label.toLowerCase();
export function buildFunctionTable(document, table, { reservedIds = [] } = {}) {
  const {
      instances,
      indexed,
      pinPages,
      shared = [],
    } = instancesFor(document, table),
    count = table.inputs.length;
  const allLabels = [
    ...new Set(instances.flatMap((instance) => instance.labels)),
  ];
  if (allLabels.length > 32)
    throw new Error("Instantiated table exceeds the 32-signal model limit.");
  if (new Set(allLabels.map(id)).size !== allLabels.length)
    throw new Error("Signal labels collide after normalization.");
  const actions = [],
    nodes = [],
    edges = [],
    signals = [],
    transitions = [];
  instances.forEach((instance, instanceIndex) => {
    const inputNames = instance.labels.slice(0, count),
      outputNames = instance.labels.slice(count);
    const existingLabels = new Set(signals.map((signal) => signal.label));
    signals.push(
      ...inputNames
        .filter((label) => !existingLabels.has(label))
        .map((label) => ({
          ...signal(id(label), 1, "input"),
          label,
        })),
      ...outputNames.map((label) => ({
        ...signal(id(label), 1, "output"),
        label,
      })),
    );
    const conditions = table.rows.map((row) =>
      fold(
        "and",
        row.inputs.flatMap((value, index) =>
          value === null
            ? []
            : [op("eq", "signal." + id(inputNames[index]), value)],
        ),
        true,
      ),
    );
    outputNames.forEach((label, index) =>
      actions.push(
        assign(
          "signal." + id(label),
          fold(
            "or",
            conditions.filter((_, row) => table.rows[row].outputs[index] === 1),
            false,
          ),
        ),
      ),
    );
    nodes.push(
      {
        id: instance.key + "_inputs",
        label: inputNames.join(" / "),
        kind: "external",
        signals: inputNames.map(id),
      },
      {
        id: instance.key + "_logic",
        label:
          "Table " +
          table.number.replace(/\.$/, "") +
          " · " +
          (indexed
            ? "channel " + instance.key.slice("channel_".length)
            : "logic"),
        note: "Derived from PDF page " + table.page,
      },
      {
        id: instance.key + "_outputs",
        label: outputNames.join(" / "),
        kind: "external",
        signals: outputNames.map(id),
      },
    );
    edges.push(
      { from: instance.key + "_inputs", to: instance.key + "_logic" },
      { from: instance.key + "_logic", to: instance.key + "_outputs" },
    );
    if (instanceIndex === 0)
      table.rows.forEach((row, index) =>
        transitions.push({
          to: "logic",
          when: conditions[index],
          actions: [],
          message:
            "Source table row " +
            (index + 1) +
            " matches " +
            inputNames.join("/") +
            ". All " +
            instances.length +
            " instance(s) evaluated independently.",
          evidence: ["function-table"],
          active: [],
        }),
      );
  });
  const active = nodes.map((node) => node.id);
  transitions.forEach((transition) => (transition.active = active));
  let modelId =
    "table-" +
    document.sha256.slice(0, 12) +
    "-p" +
    table.page +
    "-t" +
    table.number.replace(/[^\w]/g, "");
  const base = modelId;
  for (let suffix = 2; reservedIds.includes(modelId); suffix++)
    modelId = base + "-" + suffix;
  const checks = [],
    exampleInputs = [];
  for (let combination = 0; combination < table.matrix.length; combination++) {
    const inputs = [],
      expect = {};
    instances.forEach((instance, index) => {
      const localBits = table.inputs
        .map((label, bit) => ({ label, bit }))
        .filter(({ label }) => !shared.includes(label));
      let local = localBits.reduce(
        (value, { bit }) =>
          (value << 1) | ((combination >> (count - 1 - bit)) & 1),
        0,
      );
      local = (local + index) % 2 ** localBits.length;
      let value = combination;
      localBits.forEach(({ bit }, offset) => {
        const mask = 1 << (count - 1 - bit);
        value =
          (value & ~mask) |
          ((local >> (localBits.length - 1 - offset)) & 1 ? mask : 0);
      });
      table.inputs.forEach(
        (_, bit) =>
          (index === 0 || !shared.includes(table.inputs[bit])) &&
          inputs.push(
            input(
              0,
              id(instance.labels[bit]),
              (value >> (count - 1 - bit)) & 1,
            ),
          ),
      );
      table.outputs.forEach(
        (_, output) =>
          (expect["signal." + id(instance.labels[count + output])] =
            table.matrix[value][output]),
      );
    });
    checks.push({
      name:
        "Published table combination " +
        combination +
        " across independent instances",
      ticks: 1,
      inputs,
      expect,
    });
    exampleInputs.push(
      ...inputs.map((event) => ({ ...event, tick: combination * 2 })),
    );
  }
  const spec = {
    schemaVersion: 1,
    id: modelId,
    name: document.title + " · " + table.caption,
    fidelity: "behavioral",
    summary:
      "Combinational behavior compiled from a complete binary function table; " +
      instances.length +
      " instance(s).",
    scope:
      "Only the binary input/output function of " +
      table.caption +
      " on PDF page " +
      table.page +
      ". " +
      (indexed
        ? "Indexed instances are taken from the documented pin lists." +
          (shared.length
            ? " Shared input pins: " + shared.join(", ") + "."
            : "")
        : "A single table instance is modeled; package replication is not inferred.") +
      " No analog voltages, supply behavior, propagation delays, hazards, setup/hold times, or other document features are modeled.",
    parameters: [],
    registers: [],
    signals,
    nodes,
    edges,
    initialState: "logic",
    states: [
      {
        id: "logic",
        label: "Evaluate the published table for each input combination",
        entry: actions,
        tick: actions,
        active,
        transitions,
      },
    ],
    duration: Math.max(4, table.matrix.length * 2),
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
          "The positioned binary table supplies the output mapping stored in sourceTable; all input combinations are covered without conflicting overlaps.",
      },
      ...(indexed
        ? pinPages.map((page, index) => ({
            id: "pin-instances" + (index ? "-" + (index + 1) : ""),
            sourceId: "manual",
            page,
            quote: "Pin description",
            claim:
              "Consistent numbered signal lists establish the indexed instances; any shared controls are declared single input pins.",
          }))
        : []),
    ],
    assumptions: [
      "H/L represent ideal digital 1/0 as defined in the table. X is a wildcard only when explicitly defined as a don't-care input. No output values are filled for missing cells.",
      "Outputs settle immediately at each normalized tick, including tick zero. All input events at one tick are simultaneous.",
      "The default stimulus sweeps input combinations, with a two-tick dwell and rotated patterns for independent instances. This is demonstration stimulus, not an internal chip clock.",
    ],
    checks,
    sourceTable: {
      compiler: "binary-function-table-v1",
      page: table.page,
      caption: table.caption,
      inputs: table.inputs,
      outputs: table.outputs,
      rows: table.rows,
      matrix: table.matrix,
      instances: instances.map((instance) => instance.labels),
    },
  };
  validateModel(spec, [document]);
  const results = runChecks(spec);
  if (results.some((check) => !check.passed))
    throw new Error("Compiled table acceptance checks failed.");
  return { spec, checks: results, method: "function table", table };
}
