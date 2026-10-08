import { readBehaviorTable } from "./read.js";
import { behaviorFromTable } from "./behavior.js";
import { behaviorAuthoring } from "./authoring.js";
import { sourcedModel } from "../builders/sourced.js";

export function buildBehaviorTable(document, options) {
  const table = readBehaviorTable(options),
    behavior = behaviorFromTable(table);
  behavior.authoring = behaviorAuthoring(table, options.assumptions);
  if (options.additionalChecks !== undefined) {
    if (!Array.isArray(options.additionalChecks))
      throw new Error("Additional checks must be an array.");
    behavior.checks.push(...structuredClone(options.additionalChecks));
  }
  return sourcedModel(document, options, behavior);
}
