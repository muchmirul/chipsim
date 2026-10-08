// Prefer part-bearing subjects (e.g. Nexperia), then descriptive titles (TI).
// This affects display only; identity and interpretation still use bytes/data.
export function documentTitle(info, filename) {
  const generic =
    /^(?:data\s*sheet|product data\s*sheet|(?:technical )?reference manual|untitled)$/i;
  for (const value of [info?.Subject, info?.Title])
    if (
      typeof value === "string" &&
      value.trim() &&
      !generic.test(value.trim())
    )
      return value.trim().slice(0, 300);
  return filename.replace(/\.pdf$/i, "").slice(0, 300);
}
