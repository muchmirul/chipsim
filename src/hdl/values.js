import { normalizeBits } from "./vcd.js";

// Plain digits stay decimal, as in ChipSim model stimulus. Explicit 0b can
// carry unknown/released bits; a single logic letter expands to the bus width.
export function searchBits(text, width) {
  const value = String(text).trim();
  if (/^0b[01XZUWLH-]+$/i.test(value) || /^[XZUWLH-]+$/i.test(value))
    return normalizeBits(value.replace(/^0b/i, ""), width);
  if (!/^(?:\d+|0x[0-9a-f]+|0o[0-7]+)$/i.test(value) || value.length > 5000)
    throw new Error("Use decimal, 0x, 0o, or 0b logic bits (including X/Z).");
  const bits = BigInt(value).toString(2);
  return normalizeBits(bits, width);
}
