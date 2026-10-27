export function scenarioAssumptions(behavior, additional = "", csv = false) {
  return [
    csv
      ? "This scenario was authored by a developer in a CSV register table. The file fingerprint verifies the selected input, not vendor approval or correctness against silicon."
      : "This scenario was configured by a developer from a local PDF. Source quotations verify textual provenance, not the correctness of every selected behavior.",
    "One tick is a normalized model step, not a physical clock cycle.",
    ...behavior,
    ...String(additional || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  ];
}
