import { parsePayload } from "../../core/values.js";

export function readRegisterRows(text, width) {
  if (!Number.isInteger(width) || width < 1 || width > 32)
    throw new Error("Register width must be 1–32 bits.");
  if (typeof text !== "string" || text.length > 65536)
    throw new Error("Register rows must be text of at most 64 KiB.");
  const lines = text
    .split(/[;\n]/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 16)
    throw new Error("Enter 1–16 register rows.");
  const names = new Set(),
    addresses = new Set(),
    max = 2 ** width - 1;
  return lines.map((line, index) => {
    const fields = line.split(/\s+/),
      prefix = `Register row ${index + 1}: `;
    if (fields.length !== 5)
      throw new Error(prefix + "use NAME ADDRESS MODE RESET MASK.");
    const [name, rawAddress, mode, rawReset, rawMask] = fields;
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) ||
      names.has(name.toLowerCase())
    )
      throw new Error(
        prefix + "names must be unique identifiers of 1–32 characters.",
      );
    const address = parsePayload(rawAddress)?.value,
      reset = parsePayload(rawReset)?.value,
      mask = parsePayload(rawMask)?.value;
    if (address === undefined || address > 0xffffffff || addresses.has(address))
      throw new Error(prefix + "use a unique unsigned 32-bit address.");
    if (!["rw", "ro", "w1c", "w1s", "rc"].includes(mode))
      throw new Error(prefix + "mode must be rw, ro, w1c, w1s or rc.");
    if (reset === undefined || reset > max || mask === undefined || mask > max)
      throw new Error(prefix + `reset and mask must fit ${width} bits.`);
    if (mode === "ro" && mask !== 0)
      throw new Error(prefix + "read-only registers require mask zero.");
    names.add(name.toLowerCase());
    addresses.add(address);
    return { name, address, mode, reset, mask };
  });
}
