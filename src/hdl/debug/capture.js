// Exact hierarchy prefixes, never executable expressions or regular expressions.
export function normalizeCapture(value) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "scopes") ||
    !Array.isArray(value.scopes) ||
    !value.scopes.length ||
    value.scopes.length > 16 ||
    value.scopes.some(
      (path) =>
        typeof path !== "string" ||
        path.length > 256 ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\([0-9]+\)|\[[0-9]+\])?(?:\.[A-Za-z_$][A-Za-z0-9_$]*(?:\([0-9]+\)|\[[0-9]+\])?)*$/.test(
          path,
        ),
    ) ||
    new Set(value.scopes).size !== value.scopes.length
  )
    throw new Error(
      "HDL capture requires 1–16 unique exact hierarchy scopes (up to 256 characters); only scopes is supported.",
    );
  return { scopes: [...value.scopes] };
}

export const inCaptureScope = (path, scopes) =>
  !scopes ||
  scopes.some((scope) => path === scope || path?.startsWith(scope + "."));

export function selectCaptureObjects(objects, scopes) {
  if (!scopes) return objects;
  for (const scope of scopes)
    if (
      ![...objects.values()].some(
        (object) => object.kind === "instance" && object.path === scope,
      )
    )
      throw new Error(
        `HDL debug capture scope does not exist: ${scope}. Use an exact elaborated instance path.`,
      );
  const keep = new Set();
  for (const object of objects.values()) {
    if (
      !inCaptureScope(object.path || objects.get(object.parent)?.path, scopes)
    )
      continue;
    let current = object;
    while (current && !keep.has(current.id)) {
      keep.add(current.id);
      current = objects.get(current.parent);
    }
  }
  return new Map([...objects].filter(([id]) => keep.has(id)));
}
