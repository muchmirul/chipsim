const factors = {
  s: 1000000000000000n,
  ms: 1000000000000n,
  us: 1000000000n,
  ns: 1000000n,
  ps: 1000n,
  fs: 1n,
};

export function timeScale(text, { vcd = false } = {}) {
  const match = /^(\d{1,40})\s*(s|ms|us|ns|ps|fs)$/.exec(String(text).trim());
  if (
    !match ||
    BigInt(match[1]) === 0n ||
    (vcd && !["1", "10", "100"].includes(match[1]))
  )
    throw new Error(
      "Expected " +
        (vcd ? "VCD timescale 1, 10 or 100" : "positive integer time") +
        " with s/ms/us/ns/ps/fs.",
    );
  return { magnitude: match[1], unit: match[2] };
}

export function scaleFs(scale) {
  const valid = timeScale(scale.magnitude + scale.unit);
  return BigInt(valid.magnitude) * factors[valid.unit];
}

export function timeLabel(time, scale) {
  const fs = BigInt(time) * scaleFs(scale);
  for (const [unit, factor] of Object.entries(factors)) {
    if (fs < factor && unit !== "fs") continue;
    const whole = fs / factor,
      remainder = fs % factor;
    const digits = factor.toString().length - 1;
    const fraction = remainder
      ? "." + remainder.toString().padStart(digits, "0").replace(/0+$/, "")
      : "";
    return whole.toString() + fraction + " " + unit;
  }
}
