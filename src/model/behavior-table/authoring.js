import { readBehaviorTable } from "./read.js";
import { behaviorFromTable } from "./behavior.js";
import { scenarioAssumptions } from "../builders/assumptions.js";

const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
// Compare against a bounded generated shape, ignoring JSON object key order.
// Traversal follows the expected shape so malformed input cannot add depth.
function same(actual, expected) {
  if (expected === null || typeof expected !== "object")
    return actual === expected;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, at) => same(actual[at], value))
    );
  return (
    keys(actual, Object.keys(expected)) &&
    Object.entries(expected).every(([key, value]) => same(actual[key], value))
  );
}
export function behaviorAuthoring(table, assumptions = "") {
  if (typeof assumptions !== "string" || assumptions.length > 4000)
    throw new Error(
      "Additional behavior-table assumptions must be text of at most 4000 characters.",
    );
  return {
    kind: "behavior-table",
    version: 1,
    sourceId: "manual",
    evidenceId: "manual-excerpt",
    configuration: {
      inputs: [...table.inputs],
      outputs: [...table.outputs],
      states: [...table.states],
      rules: table.rules.map((row) => row.text).join("\n"),
      assumptions,
    },
  };
}

export function validateBehaviorAuthoring(model, record = model.authoring) {
  if (record === undefined) return null;
  if (
    !keys(record, [
      "kind",
      "version",
      "sourceId",
      "evidenceId",
      "configuration",
    ]) ||
    record.kind !== "behavior-table" ||
    record.version !== 1 ||
    record.sourceId !== "manual" ||
    record.evidenceId !== "manual-excerpt" ||
    !keys(record.configuration, [
      "inputs",
      "outputs",
      "states",
      "rules",
      "assumptions",
    ]) ||
    !["inputs", "outputs", "states"].every((key) =>
      Array.isArray(record.configuration[key]),
    )
  )
    throw new Error(
      "Expected a bounded version-1 behavior-table authoring record.",
    );
  const table = readBehaviorTable(record.configuration),
    normalized = behaviorAuthoring(table, record.configuration.assumptions);
  if (!same(record, normalized))
    throw new Error(
      "Authoring configuration must use normalized names and one trimmed row per line.",
    );
  if (
    !Array.isArray(model.sources) ||
    model.sources.length !== 1 ||
    model.sources[0]?.id !== record.sourceId ||
    !Array.isArray(model.evidence) ||
    model.evidence.length !== 1 ||
    model.evidence[0]?.id !== record.evidenceId ||
    model.evidence[0]?.sourceId !== record.sourceId
  )
    throw new Error(
      "Behavior authoring must link to its single declared source and evidence record.",
    );
  const expected = behaviorFromTable(table);
  for (const field of [
    "summary",
    "scope",
    "parameters",
    "signals",
    "registers",
    "nodes",
    "edges",
    "initialState",
    "states",
    "duration",
    "exampleInputs",
  ])
    if (!same(model[field], expected[field]))
      throw new Error(
        `Authoring configuration does not match generated ${field}. Revise through the builder, or remove authoring before editing generated JSON directly.`,
      );
  const assumptions = scenarioAssumptions(
    expected.assumptions,
    record.configuration.assumptions,
  );
  if (!same(model.assumptions, assumptions))
    throw new Error(
      "Authoring assumptions do not match the entered configuration.",
    );
  if (
    !Array.isArray(model.checks) ||
    !same(model.checks.slice(0, expected.checks.length), expected.checks)
  )
    throw new Error(
      "Authoring generated checks do not match the entered rules. Additional independent checks may follow them.",
    );
  return { record: normalized, generatedChecks: expected.checks.length };
}

// Legacy entered tables have no record. Recover only when their entire bounded
// generated behavior and provenance can be reproduced, never from a label alone.
export function behaviorDraft(model) {
  let validated;
  if (model.authoring !== undefined)
    validated = validateBehaviorAuthoring(model);
  else {
    try {
      const rows =
        model.assumptions?.filter((text) =>
          /^Developer-entered row \d+: /.test(text),
        ) || [];
      if (
        !rows.length ||
        rows.some(
          (text, at) => !text.startsWith(`Developer-entered row ${at + 1}: `),
        )
      )
        return null;
      const configuration = {
        inputs: model.signals
          .filter((signal) => signal.direction === "input")
          .map((signal) => signal.label),
        outputs: model.signals
          .filter((signal) => signal.direction === "output")
          .map((signal) => signal.label),
        states: model.parameters.find(
          (parameter) => parameter.id === "initialState",
        )?.options,
        rules: rows
          .map((text) => text.replace(/^Developer-entered row \d+: /, ""))
          .join("\n"),
      };
      const table = readBehaviorTable(configuration),
        prefix = scenarioAssumptions(behaviorFromTable(table).assumptions);
      if (!same(model.assumptions.slice(0, prefix.length), prefix)) return null;
      validated = validateBehaviorAuthoring(
        model,
        behaviorAuthoring(
          table,
          model.assumptions.slice(prefix.length).join("\n"),
        ),
      );
    } catch {
      return null;
    }
  }
  const evidence = model.evidence[0];
  return {
    sourceHash: model.sources[0].sha256,
    options: {
      ...structuredClone(validated.record.configuration),
      name: model.name,
      id: model.id,
      page: evidence.page,
      quote: evidence.quote,
      claim: evidence.claim,
      additionalChecks: structuredClone(
        model.checks.slice(validated.generatedChecks),
      ),
    },
  };
}
