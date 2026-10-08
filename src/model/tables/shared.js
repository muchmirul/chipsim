import { op } from "../builders/shared.js";
export const pinId = (label) => "pin_" + label.toLowerCase();
export const fold = (operator, values, empty) =>
  !values.length
    ? empty
    : values.length === 1
      ? values[0]
      : op(
          operator,
          fold(operator, values.slice(0, Math.ceil(values.length / 2)), empty),
          fold(operator, values.slice(Math.ceil(values.length / 2)), empty),
        );
export function tableId(document, table, reservedIds, prefix = "table") {
  const base = `${prefix}-${document.sha256.slice(0, 12)}-p${table.page}-t${table.number.replace(/[^\w]/g, "")}`;
  let id = base;
  for (let suffix = 2; reservedIds.includes(id); suffix++)
    id = base + "-" + suffix;
  return id;
}
