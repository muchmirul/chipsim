const kinds = new Set([
  "rtl",
  "gate",
  "bmc",
  "prove",
  "cover",
  "equivalence",
  "timing",
]);

export function evaluateRequirements(policy, coverage, checks) {
  if (policy === undefined) return [];
  if (!Array.isArray(policy) || policy.length > 256)
    throw Error("Expected bounded release evidencePolicy array");
  return policy.map((rule) => {
    if (
      !rule ||
      !coverage.declared.includes(rule.id) ||
      !kinds.has(rule.kind) ||
      Object.keys(rule).some(
        (k) =>
          ![
            "id",
            "kind",
            "task",
            "minDepth",
            "clock",
            "property",
            "waiver",
          ].includes(k),
      ) ||
      (rule.minDepth !== undefined &&
        (rule.kind !== "bmc" ||
          !Number.isSafeInteger(rule.minDepth) ||
          rule.minDepth < 1)) ||
      (rule.kind === "timing" && !rule.clock) ||
      (rule.clock !== undefined && rule.kind !== "timing") ||
      (["bmc", "prove", "cover", "equivalence"].includes(rule.kind) &&
        !rule.task) ||
      (rule.property !== undefined &&
        !["bmc", "prove", "cover"].includes(rule.kind)) ||
      ["clock", "property", "task", "waiver"].some(
        (k) =>
          rule[k] !== undefined &&
          (typeof rule[k] !== "string" ||
            !rule[k].trim() ||
            rule[k].length > 1024),
      )
    )
      throw Error("Invalid release evidence policy for " + rule?.id);
    if (rule.waiver) return { ...rule, verdict: "waived" };
    const match = checks.find((c) => {
      if (c.verdict !== "pass" || (rule.task && c.task !== rule.task))
        return false;
      if (["rtl", "gate"].includes(rule.kind)) {
        const names = coverage.mapping[rule.id];
        return (
          c.name === "tests" &&
          c.task === rule.kind &&
          names?.length &&
          names.every((n) =>
            c.cases?.some((t) => t.name === n && t.verdict === "pass"),
          )
        );
      }
      if (rule.kind === "timing")
        return (
          c.name === "timing" &&
          !!rule.clock &&
          c.context?.corners?.length &&
          c.context.corners.every(
            (corner) =>
              c.context.clockCoverage?.[corner]?.clocks?.includes(rule.clock) &&
              c.context.clockCoverage[corner].timedPathGroups?.includes(
                rule.clock,
              ),
          )
        );
      if (!rule.task) return false;
      if (rule.kind === "equivalence") return c.name === "equivalence";
      return (
        c.name === "formal" &&
        c.context?.tasks?.some(
          (t) =>
            t.mode === rule.kind &&
            t.verdict === "PASS" &&
            (!rule.minDepth || t.depth >= rule.minDepth) &&
            (!rule.property ||
              t.properties?.some(
                (p) =>
                  p.name === rule.property &&
                  p.kind === (rule.kind === "cover" ? "cover" : "assert"),
              )),
        )
      );
    });
    return {
      ...rule,
      verdict: match ? "pass" : "missing",
      check: match?.id || null,
      cases: coverage.mapping[rule.id] || [],
    };
  });
}

// Run coverage counts requirement IDs, not passed checks or waived rules.
export function summarizeRequirementEvidence(requirements, results) {
  const covered = [],
    unverified = [];
  for (const { id } of requirements || []) {
    const rules = results.filter((r) => r.id === id);
    const backed =
      rules.length && rules.every((r) => r.verdict === "pass" && r.check);
    (backed ? covered : unverified).push(id);
  }
  return {
    status:
      requirements == null
        ? "unavailable"
        : !requirements.length
          ? "not-declared"
          : !covered.length
            ? "unverified"
            : unverified.length
              ? "partial"
              : "covered",
    declared: requirements?.length ?? null,
    covered,
    unverified,
  };
}

export function requirementCoverage(acceptance, requirements = []) {
  const cases = acceptance.cases;
  const mapping =
    acceptance.requirements === undefined ? {} : acceptance.requirements;
  if (!mapping || Array.isArray(mapping) || typeof mapping !== "object")
    throw Error(
      "Acceptance requirements must map requirement IDs to case names",
    );
  const ids = new Set(requirements.map((r) => r.id));
  for (const [id, names] of Object.entries(mapping)) {
    if (!ids.has(id)) throw Error("Unknown requirement: " + id);
    if (
      !Array.isArray(names) ||
      !names.length ||
      new Set(names).size !== names.length ||
      names.some((n) => !cases.includes(n))
    )
      throw Error("Invalid acceptance case mapping: " + id);
  }
  return {
    declared: requirements.map((r) => r.id),
    mapping,
    unmapped: [...ids].filter((id) => !Object.hasOwn(mapping, id)),
    scope:
      "Authored traceability only; not proof of specification completeness",
  };
}
