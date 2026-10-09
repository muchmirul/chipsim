import { validateWaveform } from "./vcd.js";
import { timeScale, scaleFs } from "./time.js";

function modelBits(value, width) {
  if (value === undefined || value === null) return null;
  if (value === "Z") return "Z".repeat(width);
  if (!Number.isSafeInteger(value))
    throw new Error("Model comparison requires integer values or Z.");
  return BigInt.asUintN(width, BigInt(value)).toString(2).padStart(width, "0");
}

export function comparableTrace(data, tickTime) {
  if (data?.format === "chipsim-waveform") {
    validateWaveform(data);
    const scale = scaleFs(data.timescale);
    let values = Object.fromEntries(data.signals.map((s) => [s.id, null]));
    return {
      signals: data.signals,
      samples: data.events.map((event) => {
        values = { ...values, ...event.changes };
        return { time: BigInt(event.time) * scale, values };
      }),
      kind: "waveform",
    };
  }
  if (
    data?.format !== "chipsim-trace" ||
    data.version !== 1 ||
    !Array.isArray(data.trace) ||
    !data.trace.length ||
    data.trace.length > 10001
  )
    throw new Error(
      "Comparison accepts VCD/waveform JSON or exported ChipSim trace JSON.",
    );
  if (!tickTime)
    throw new Error(
      "ChipSim model ticks require an explicit leftTick/rightTick duration, e.g. 1ns.",
    );
  const scale = scaleFs(timeScale(tickTime));
  const signals = [
    ...(data.model?.signals || data.model?.definition?.signals || []).map(
      (s) => ({ ...s, id: "signal." + s.id }),
    ),
    ...(data.model?.registers || data.model?.definition?.registers || []).map(
      (s) => ({ ...s, id: "reg." + s.id }),
    ),
  ];
  if (
    !signals.length ||
    signals.length > 512 ||
    signals.some(
      (s) => !Number.isInteger(s.width) || s.width < 1 || s.width > 4096,
    ) ||
    new Set(signals.map((s) => s.id)).size !== signals.length
  )
    throw new Error(
      "Model trace requires unique signal/register declarations and widths. Export it with the current ChipSim version.",
    );
  return {
    kind: "model",
    signals,
    samples: data.trace.map((snapshot, index) => {
      if (snapshot?.tick !== index || snapshot.phase === "fault")
        throw new Error(
          "Model comparison requires a non-faulting contiguous trace starting at tick zero.",
        );
      const values = Object.fromEntries(
        signals.map((s) => {
          const group = s.id.startsWith("signal.") ? "signals" : "registers";
          return [
            s.id,
            modelBits(
              snapshot[group]?.[s.id.slice(s.id.indexOf(".") + 1)],
              s.width,
            ),
          ];
        }),
      );
      return { time: BigInt(index) * scale, values };
    }),
  };
}

// Continuous comparison checks held values at the union of change times.
// Sampled comparison makes its observation grid explicit, without silently
// aligning event indices or hiding unknown bits as don't-cares.
export function compareBehavior(leftData, rightData, config) {
  if (
    !config ||
    !Array.isArray(config.signals) ||
    !config.signals.length ||
    config.signals.length > 512
  )
    throw new Error(
      "Comparison mapping requires a nonempty signals array of {left,right,role}.",
    );
  const allowed = new Set([
    "signals",
    "mode",
    "leftTick",
    "rightTick",
    "sampleEvery",
    "from",
    "to",
  ]);
  for (const key of Object.keys(config))
    if (!allowed.has(key)) throw new Error("Unknown comparison field " + key);
  const left = comparableTrace(leftData, config.leftTick),
    right = comparableTrace(rightData, config.rightTick);
  const mode = config.mode || "continuous";
  if (!["continuous", "sampled"].includes(mode))
    throw new Error("Comparison mode must be continuous or sampled.");
  if (mode === "continuous" && config.sampleEvery !== undefined)
    throw new Error("sampleEvery requires sampled comparison mode.");
  if ((left.kind === "model" || right.kind === "model") && !config.mode)
    throw new Error(
      "Model comparison requires an explicit continuous or sampled mode.",
    );
  const mappings = config.signals.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).some((k) => !["left", "right", "role"].includes(k))
    )
      throw new Error("Invalid signal mapping fields.");
    const l = left.signals.find((s) => s.id === entry.left),
      r = right.signals.find((s) => s.id === entry.right);
    if (
      !l ||
      !r ||
      l.width !== r.width ||
      (entry.role && !["input", "output"].includes(entry.role))
    )
      throw new Error(
        "Missing signal, incompatible widths or invalid role in mapping " +
          entry.left +
          " → " +
          entry.right,
      );
    return {
      left: l.id,
      right: r.id,
      width: l.width,
      role: entry.role || "output",
    };
  });
  if (
    new Set(mappings.map((m) => m.left)).size !== mappings.length ||
    new Set(mappings.map((m) => m.right)).size !== mappings.length
  )
    throw new Error("Duplicate signal mappings.");
  const leftStart = left.samples[0].time,
    rightStart = right.samples[0].time,
    leftEnd = left.samples.at(-1).time,
    rightEnd = right.samples.at(-1).time;
  const duration = (text) => scaleFs(timeScale(text));
  const bound = (text) =>
    /^0\s*(s|ms|us|ns|ps|fs)$/.test(String(text)) ? 0n : duration(text);
  const from =
    config.from === undefined
      ? leftStart > rightStart
        ? leftStart
        : rightStart
      : bound(config.from);
  const to =
    config.to === undefined
      ? leftEnd < rightEnd
        ? leftEnd
        : rightEnd
      : bound(config.to);
  if (
    from < leftStart ||
    from < rightStart ||
    to > leftEnd ||
    to > rightEnd ||
    from > to
  )
    throw new Error("Requested comparison range is outside one of the traces.");
  const coverageMatches =
    (config.from !== undefined || leftStart === rightStart) &&
    (config.to !== undefined || leftEnd === rightEnd);
  let times;
  if (mode === "sampled") {
    const every = duration(config.sampleEvery);
    if ((to - from) / every > 40000n)
      throw new Error("Comparison exceeds 40001 samples.");
    times = [];
    for (let time = from; time <= to; time += every) times.push(time);
    if (times.at(-1) !== to)
      throw new Error("Comparison endpoint must lie on the sample grid.");
  } else {
    times = [
      ...new Set(
        [
          from,
          to,
          ...left.samples.map((s) => s.time),
          ...right.samples.map((s) => s.time),
        ]
          .filter((t) => t >= from && t <= to)
          .map(String),
      ),
    ]
      .map(BigInt)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  let li = 0,
    ri = 0,
    changedSamples = 0,
    inputDifferences = 0,
    outputDifferences = 0,
    unavailable = 0;
  const differences = [];
  for (const time of times) {
    while (li + 1 < left.samples.length && left.samples[li + 1].time <= time)
      li++;
    while (ri + 1 < right.samples.length && right.samples[ri + 1].time <= time)
      ri++;
    const changes = [];
    for (const mapping of mappings) {
      const before = left.samples[li].values[mapping.left],
        after = right.samples[ri].values[mapping.right];
      if (before === null || after === null) unavailable++;
      if (before !== after || before === null || after === null) {
        changes.push({ ...mapping, leftValue: before, rightValue: after });
        if (mapping.role === "input") inputDifferences++;
        else outputDifferences++;
      }
    }
    if (changes.length) {
      changedSamples++;
      if (differences.length < 2000)
        differences.push({ timeFs: time.toString(), changes });
    }
  }
  return {
    format: "chipsim-hdl-comparison",
    version: 1,
    configuration: structuredClone(config),
    match: changedSamples === 0 && coverageMatches,
    mode,
    rangeFs: { from: from.toString(), to: to.toString() },
    samples: times.length,
    mappings,
    coverageMatches,
    coverage: {
      leftStart: leftStart.toString(),
      rightStart: rightStart.toString(),
      leftEnd: leftEnd.toString(),
      rightEnd: rightEnd.toString(),
    },
    changedSamples,
    inputDifferences,
    outputDifferences,
    unavailable,
    firstDifferenceFs: differences[0]?.timeFs ?? null,
    differences,
    truncated: changedSamples > differences.length,
    stimulus: mappings.some((m) => m.role === "input")
      ? inputDifferences
        ? "Mapped inputs differ; output differences do not establish a behavior discrepancy under identical stimulus."
        : "Mapped inputs agree at the compared times; unlisted inputs are not checked."
      : "No input mapping supplied; identical stimulus has not been checked.",
    scope:
      mode === "sampled"
        ? "Only mapped signals on the explicit sample grid. Changes between samples are not compared; this is not whole-design equivalence."
        : "Only mapped dumped signals and held values in the compared interval. Delta-cycle history and unlisted signals are not compared; this is not whole-design equivalence.",
  };
}
