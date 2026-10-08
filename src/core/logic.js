// Z describes a released output driver, not a numeric level or resolved bus.
export const HIGH_IMPEDANCE = "Z";
export function truth(value) {
  if (value === HIGH_IMPEDANCE)
    throw new Error("High-impedance Z cannot be used as a logical condition");
  return Boolean(value);
}
export function vcdBits(value, width) {
  if (value === undefined) return "x".repeat(width);
  if (value === HIGH_IMPEDANCE) return "z".repeat(width);
  return (Math.trunc(value) >>> 0).toString(2).padStart(width, "0");
}
