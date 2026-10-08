export function scenarioAssumptions(behavior, additional = "") {
  return [
    "This scenario was configured by a developer from a local PDF. Source quotations verify textual provenance, not the correctness of every selected behavior.",
    "One tick is a normalized model step, not a physical clock cycle.",
    ...behavior,
    ...String(additional || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  ];
}
