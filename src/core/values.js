const hex = (n, w = 2) =>
  "0x" + (n >>> 0).toString(16).toUpperCase().padStart(w, "0");
const payloadFormats = ["decimal", "hex", "binary", "octal"];
function parsePayload(raw) {
  const text = String(raw).trim();
  const format = /^0x[0-9a-f]+$/i.test(text)
    ? "hex"
    : /^0b[01]+$/i.test(text)
      ? "binary"
      : /^0o[0-7]+$/i.test(text)
        ? "octal"
        : /^\d+$/.test(text)
          ? "decimal"
          : null;
  if (!format) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? { value, format } : null;
}
function formatPayload(value, format, bits = 8) {
  if (format === "decimal") return String(value);
  if (format === "binary") return "0b" + value.toString(2).padStart(bits, "0");
  if (format === "octal")
    return "0o" + value.toString(8).padStart(Math.ceil(bits / 3), "0");
  return hex(value, Math.ceil(bits / 4));
}
export { hex, payloadFormats, parsePayload, formatPayload };
