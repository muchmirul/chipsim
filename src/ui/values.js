import { formatPayload } from "../core/values.js";
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const valueText = (value, format, width = 8) =>
  typeof value === "number" && value >= 0
    ? formatPayload(value, format, width)
    : String(value);
