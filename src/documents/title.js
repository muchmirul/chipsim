// Prefer part-bearing subjects (e.g. Nexperia), then descriptive titles (TI).
// This affects display only; identity and interpretation still use bytes/data.
export function documentTitle(info, filename) {
  const generic =
    /^(?:data\s*sheet|product data\s*sheet|(?:technical )?reference manual|untitled)$/i;
  // A bare catalog/revision code is useful provenance but a poor display title
  // when the publisher supplied a descriptive title as well.
  const code = /^[A-Z]{2,}[A-Z\d]+-\d{4,}$/;
  const candidates =
    typeof info?.Subject === "string" && code.test(info.Subject.trim())
      ? [info?.Title, info?.Subject]
      : [info?.Subject, info?.Title];
  for (const value of candidates)
    if (
      typeof value === "string" &&
      value.trim() &&
      !generic.test(value.trim())
    )
      return value.trim().slice(0, 300);
  return filename.replace(/\.pdf$/i, "").slice(0, 300);
}
