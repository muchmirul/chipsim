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
