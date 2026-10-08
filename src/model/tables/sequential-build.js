import { instancesFor, inputDeclarations } from "./pins.js";
import { sequentialScenarios } from "./sequential-scenarios.js";
import { pinId, fold, tableId } from "./shared.js";
import { clockPinMatches } from "./clock-patterns.js";
import { op, assign, signal, register, parameter } from "../builders/shared.js";
import { validateModel } from "../validate.js";
import { runChecks } from "../engine.js";
export function buildSequentialTable(
  document,
  table,
  { reservedIds = [] } = {},
) {
  const {
      instances,
      indexed,
      pinPages = [],
      shared = [],
    } = instancesFor(document, table),
    count = table.inputs.length;
  const labels = [...new Set(instances.flatMap((instance) => instance.labels))];
  if (labels.length > 32 || new Set(labels.map(pinId)).size !== labels.length)
    throw new Error(
      "Instantiated sequential signals exceed bounds or collide after normalization.",
    );
  const clocks = [
      ...new Set(
        instances.map((instance) => instance.labels[table.clock.index]),
      ),
    ],
    clockProof = [];
  for (const clock of clocks) {
    const declarations = document.pages.flatMap((page) =>
      inputDeclarations(page, clock),
    );
    if (
      !declarations.length ||
      new Set(declarations.map((item) => item.pin)).size !== 1 ||
      declarations.some(
        (item) =>
          !item.valid || !clockPinMatches(item.description, table.clock.edges),
      )
    )
      throw new Error(
        "Sequential clock " +
          clock +
          " needs a positioned pin description declaring an edge-triggered clock input.",
      );
    for (const item of declarations)
      if (!clockProof.some((proof) => proof.page === item.page))
        clockProof.push({ page: item.page, quote: item.description });
  }
  const prev = (clock) => "previous_" + pinId(clock),
    edge = (clock, kind) => kind + "_" + pinId(clock),
    pair = (clock) => "pair_" + pinId(clock);
  const registers = clocks.flatMap((clock) => [
    register(prev(clock), 1),
    ...table.clock.edges.map((kind) => register(edge(clock, kind), 1)),
    ...(table.clock.pairs ? [register(pair(clock), 2)] : []),
  ]);
  const signals = [],
    nodes = [],
    edges = [],
    entry = [],
    step = [],
    conditions = [];
  let outputBit = 0;
  const flagActions = clocks.flatMap((clock) =>
    table.clock.edges.map((kind) =>
      assign(
        "reg." + edge(clock, kind),
        op(
          "and",
          op("eq", "reg." + prev(clock), kind === "rise" ? 0 : 1),
          op("eq", "signal." + pinId(clock), kind === "rise" ? 1 : 0),
        ),
      ),
    ),
  );
  for (const [instanceIndex, instance] of instances.entries()) {
    const ins = instance.labels.slice(0, count),
      outs = instance.labels.slice(count),
      clock = ins[table.clock.index];
    for (const [index, label] of instance.labels.entries())
      if (!signals.some((s) => s.id === pinId(label)))
        signals.push({
          ...signal(pinId(label), 1, index < count ? "input" : "output"),
          label,
        });
    const when = table.rows.map((row) =>
      fold(
        "and",
        row.inputs.flatMap((value, index) =>
          value === null
            ? []
            : [
                typeof value === "object"
                  ? op(
                      "bitAnd",
                      op("shiftRight", value.clock, "reg." + pair(clock)),
                      1,
                    )
                  : typeof value === "string"
                    ? "reg." + edge(clock, value)
                    : op("eq", "signal." + pinId(ins[index]), value),
              ],
        ),
        true,
      ),
    );
    if (!instanceIndex) conditions.push(...when);
    const select = (output, filters) =>
      table.rows.reduceRight(
        (value, row, index) =>
          filters(row)
            ? op(
                "select",
                when[index],
                row.outputs[output] === "hold"
                  ? "signal." + pinId(outs[output])
                  : row.outputs[output],
                value,
              )
            : value,
        "signal." + pinId(outs[output]),
      );
    for (const [output, label] of outs.entries()) {
      entry.push(
        assign(
          "signal." + pinId(label),
          op(
            "bitAnd",
            op("shiftRight", "param.initialOutputs", outputBit++),
            1,
          ),
        ),
      );
      entry.push(
        assign(
          "signal." + pinId(label),
          select(
            output,
            (row) =>
              !row.inputs.some(
                (value) =>
                  value !== null &&
                  (typeof value === "string" || typeof value === "object"),
              ),
          ),
        ),
      );
      step.push(
        assign(
          "signal." + pinId(label),
          select(output, () => true),
        ),
      );
    }
    nodes.push(
      {
        id: instance.key + "_inputs",
        label: ins.join(" / "),
        kind: "external",
        signals: ins.map(pinId),
      },
      {
        id: instance.key + "_storage",
        label:
          (indexed ? "Channel " + instance.key.slice(8) : "Table") +
          " · retained state",
        kind: "datapath",
        signals: outs.map(pinId),
      },
      {
        id: instance.key + "_outputs",
        label: outs.join(" / "),
        kind: "external",
        signals: outs.map(pinId),
      },
    );
    edges.push(
      { from: instance.key + "_inputs", to: instance.key + "_storage" },
      { from: instance.key + "_storage", to: instance.key + "_outputs" },
    );
  }
  entry.unshift(
    ...clocks.flatMap((clock) =>
      table.clock.pairs
        ? [assign("reg." + pair(clock), op("mul", "signal." + pinId(clock), 3))]
        : [],
    ),
    ...clocks.flatMap((clock) =>
      table.clock.edges.map((kind) => assign("reg." + edge(clock, kind), 0)),
    ),
  );
  const history = clocks.map((clock) =>
    assign("reg." + prev(clock), "signal." + pinId(clock)),
  );
  entry.push(...history);
  step.unshift(
    ...clocks.flatMap((clock) =>
      table.clock.pairs
        ? [
            assign(
              "reg." + pair(clock),
              op(
                "add",
                op("mul", "reg." + prev(clock), 2),
                "signal." + pinId(clock),
              ),
            ),
          ]
        : [],
    ),
    ...flagActions,
  );
  step.push(...history);
  nodes.push({
    id: "clock_history",
    label: "Clock history / edge detection",
    registers: registers.map((reg) => reg.id),
    signals: clocks.map(pinId),
  });
  const active = nodes.map((node) => node.id);
  const transitions = table.rows.map((row, index) => ({
    to: "run",
    when: conditions[index],
    actions: [],
    message:
      "Source table row " +
      (index + 1) +
      ": " +
      (row.outputs.every((value) => value === "hold")
        ? "no change"
        : "specified output update") +
      " for first channel; all " +
      instances.length +
      " channel(s) evaluated.",
    evidence: ["function-table"],
    active,
  }));
  transitions.push({
    to: "run",
    when: true,
    actions: [],
    message: "No active clock/table row · retained outputs",
    evidence: ["edge-contract"],
    active,
  });
  const { checks, exampleInputs, duration } = sequentialScenarios(
    table,
    instances,
    shared,
  );
  const spec = {
    schemaVersion: 1,
    id: tableId(document, table, reservedIds, "state-table"),
    name: document.title + " · " + table.caption,
    fidelity: "behavioral",
    summary:
      "Stateful binary logic derived from an edge-triggered function table; " +
      instances.length +
      " channel(s).",
    scope: `Only the digital function of ${table.caption} on PDF page ${table.page}, with clock history, retained outputs, and documented pin instances. ${indexed ? "Indexed package channels follow validated pin declarations." : "Generic unindexed headings model one table instance; package replication and wiring are omitted."} Initial outputs are configurable scenario values, not specified power-on state. Physical set-up/hold times, metastability, delays, voltage thresholds and unmodeled chip features are omitted.`,
    parameters: [
      parameter(
        "initialOutputs",
        "Initial retained output bits",
        0,
        0,
        2 ** outputBit - 1,
      ),
    ],
    registers,
    signals,
    nodes,
    edges,
    initialState: "initialize",
    states: [
      {
        id: "initialize",
        label:
          "Establish initial state and clock history without inventing an edge",
        entry,
        tick: step,
        active,
        transitions,
      },
      {
        id: "run",
        label: "Evaluate edge-triggered function table",
        entry: [],
        tick: step,
        active,
        transitions,
      },
    ],
    duration,
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
          "Positioned table rows specify binary updates, clock-edge conditions, and explicit no-change outputs.",
      },
      {
        id: "edge-contract",
        sourceId: "manual",
        ...table.trigger,
        claim:
          "Documented edge-triggered behavior permits retaining outputs outside the table's active clock transitions.",
      },
      ...(table.retention
        ? [
            {
              id: "retention-definition",
              sourceId: "manual",
              page: table.page,
              quote: table.retention.definition,
              claim:
                "The local table legend defines Q0 as Q's previous state, not a fixed output level or another signal.",
            },
          ]
        : []),
      ...clockProof.map((proof, index) => ({
        id: "clock-pin-" + index,
        sourceId: "manual",
        ...proof,
        claim: "The clock signal is declared an edge-triggered input pin.",
      })),
      ...pinPages.map((page, index) => ({
        id: "pin-instances-" + index,
        sourceId: "manual",
        page,
        quote: "Pin description",
        claim:
          "Numbered pin lists identify independent data/output channels and any shared controls.",
      })),
    ],
    assumptions: [
      ...(table.clock.pairs
        ? [
            "Comma-separated clock alternatives describe steady levels and explicitly defined transitions. Pair codes 0/1/2/3 mean low-to-low/rising/falling/high-to-high. All alternatives must retain outputs; arbitrary list-driven updates are not inferred.",
          ]
        : []),
      "Configured initialOutputs supplies retained output bits in instance order, first instance in the least significant bits. No deterministic silicon power-on state is inferred. Undriven modeled input pins start at ideal digital zero as a scenario choice.",
      "Tick zero establishes the supplied clock level without creating a clock edge; documented asynchronous rows can still act at tick zero.",
      "Lowercase h/l set-up levels are evaluated as ideal values present at the edge. Physical set-up/hold violations and metastability are not predicted. Events within one normalized tick are simultaneous.",
      "Unmatched patterns retain outputs only outside the documented active clock transitions. Undefined active transitions and conflicting rows reject compilation.",
      "The default demonstration prepares data one normalized tick before toggling the clock. These ticks do not establish physical timing compliance.",
    ],
    checks,
    sourceTable: {
      compiler: "sequential-function-table-v1",
      page: table.page,
      caption: table.caption,
      inputs: table.inputs,
      outputs: table.outputs,
      rows: table.rows,
      symbolRows: table.rawRows,
      matrix: table.matrix,
      clock: table.clock,
      ...(table.retention ? { retention: table.retention } : {}),
      instances: instances.map((instance) => instance.labels),
    },
  };
  validateModel(spec, [document]);
  const results = runChecks(spec);
  if (results.some((check) => !check.passed))
    throw new Error("Sequential table acceptance checks failed.");
  return { spec, checks: results, method: "sequential function table", table };
}
