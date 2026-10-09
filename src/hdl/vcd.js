import { timeScale } from "./time.js";

export const limits = {
  bytes: 64 * 1048576,
  signals: 512,
  width: 4096,
  samples: 20000,
  cells: 2000000,
};
const logic = /^[01XZUWLH-]+$/;
const decimal = /^(0|[1-9]\d{0,39})$/;

export function normalizeBits(value, width) {
  value = String(value).toUpperCase();
  if (!logic.test(value) || value.length > width)
    throw new Error("Invalid logic value or value wider than its signal.");
  return value.padStart(width, /^[XZUWLH-]/.test(value) ? value[0] : "0");
}

// VCD is data. Keep final values at each timestamp, including aliases and
// uninitialized values. Same-time writes are not source/debugger steps.
export function parseVCD(text, origin = {}) {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > limits.bytes
  )
    throw new Error("VCD exceeds 64 MiB.");
  const tokens = text.match(/\S+/g) || [];
  let index = 0,
    scale,
    ended = false,
    currentTime = "0",
    touched = false,
    dumpActive = false;
  const scopes = [],
    signals = [],
    codes = new Map(),
    ids = new Set(),
    events = [];
  let changes = Object.create(null);
  const take = () => {
    if (index >= tokens.length) throw new Error("Truncated VCD.");
    return tokens[index++];
  };
  const body = () => {
    const parts = [];
    while (true) {
      const item = take();
      if (item === "$end") return parts;
      parts.push(item);
    }
  };
  const flush = () => {
    if (!touched) return;
    if (events.at(-1)?.time === currentTime)
      Object.assign(events.at(-1).changes, changes);
    else events.push({ time: currentTime, changes });
    if (
      events.length > limits.samples ||
      events.length * signals.length > limits.cells
    )
      throw new Error("VCD exceeds sample/signal inspection limits.");
    changes = Object.create(null);
    touched = false;
  };
  const update = (code, value) => {
    const aliases = codes.get(code);
    if (!aliases)
      throw new Error("VCD value references undeclared identifier " + code);
    for (const signal of aliases)
      changes[signal.id] = normalizeBits(value, signal.width);
    touched = true;
  };
  while (!ended) {
    const command = take();
    const parts = body();
    if (command === "$timescale") {
      if (scale) throw new Error("Duplicate VCD timescale.");
      scale = timeScale(parts.join(""), { vcd: true });
    } else if (command === "$scope") {
      if (parts.length !== 2) throw new Error("Invalid VCD scope.");
      scopes.push(parts[1]);
    } else if (command === "$upscope") {
      if (parts.length || !scopes.length)
        throw new Error("Unbalanced VCD scope.");
      scopes.pop();
    } else if (command === "$var") {
      const [type, rawWidth, code, name, ...range] = parts,
        width = Number(rawWidth);
      if (
        ![
          "wire",
          "reg",
          "logic",
          "bit",
          "integer",
          "parameter",
          "tri",
          "tri0",
          "tri1",
          "wand",
          "wor",
          "supply0",
          "supply1",
        ].includes(type)
      )
        throw new Error(
          "Unsupported VCD variable type " +
            type +
            "; only digital logic is supported.",
        );
      if (
        !/^\d+$/.test(rawWidth) ||
        !Number.isInteger(width) ||
        width < 1 ||
        width > limits.width ||
        !code ||
        !name ||
        range.length > 1 ||
        (range.length && !/^\[-?\d+(?::-?\d+)?\]$/.test(range[0]))
      )
        throw new Error("Invalid VCD signal declaration.");
      const id = [...scopes, name.replace(/^\\/, "")].join(".");
      if (ids.has(id) || id.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(id))
        throw new Error("Duplicate or invalid VCD signal name " + id);
      ids.add(id);
      const signal = {
        id,
        width,
        type,
        code,
        ...(range.length ? { range: range[0] } : {}),
      };
      const aliases = codes.get(code) || [];
      if (aliases.some((alias) => alias.width !== width))
        throw new Error("VCD alias widths disagree.");
      aliases.push(signal);
      codes.set(code, aliases);
      signals.push(signal);
      if (signals.length > limits.signals)
        throw new Error("VCD exceeds 512 declared signals.");
    } else if (command === "$enddefinitions") {
      if (parts.length || scopes.length)
        throw new Error("Unbalanced VCD definitions.");
      ended = true;
    } else if (!["$comment", "$date", "$version"].includes(command))
      throw new Error("Unsupported VCD header command " + command);
  }
  if (!scale || !signals.length)
    throw new Error("VCD requires timescale and digital signals.");
  // An initial unavailable sample preserves the timeline before the first dump.
  touched = true;
  while (index < tokens.length) {
    const item = take();
    if (item.startsWith("#")) {
      if (dumpActive)
        throw new Error("VCD timestamp inside unterminated dump block.");
      const time = item.slice(1);
      if (!decimal.test(time) || BigInt(time) < BigInt(currentTime))
        throw new Error("Invalid or decreasing VCD timestamp.");
      if (time !== currentTime) flush();
      currentTime = time;
      touched = true; // Retain the final timestamp even when no values change.
    } else if (item === "$comment") body();
    else if (["$dumpvars", "$dumpall", "$dumpon", "$dumpoff"].includes(item)) {
      if (dumpActive) throw new Error("Nested VCD dump block.");
      dumpActive = true;
    } else if (item === "$end") {
      if (!dumpActive) throw new Error("Unexpected VCD $end.");
      dumpActive = false;
    } else if (/^[bB]/.test(item)) update(take(), item.slice(1));
    else if (/^[01xXzZuUwWlLhH-]/.test(item)) {
      const code = item.slice(1);
      if (codes.get(code)?.[0]?.width !== 1)
        throw new Error("Scalar VCD value requires a one-bit declaration.");
      update(code, item[0]);
    } else throw new Error("Unsupported or malformed VCD value " + item);
  }
  if (dumpActive) throw new Error("Unterminated VCD dump block.");
  flush();
  return validateWaveform({
    format: "chipsim-waveform",
    version: 1,
    timescale: scale,
    signals,
    events,
    origin,
    semantics:
      "Final dumped values per timestamp; waveform replay does not execute HDL or retain delta-cycle/source-step history.",
  });
}

export function validateWaveform(wave) {
  if (
    wave?.format !== "chipsim-waveform" ||
    wave.version !== 1 ||
    !Array.isArray(wave.signals) ||
    !Array.isArray(wave.events)
  )
    throw new Error("Unsupported waveform format.");
  timeScale(wave.timescale?.magnitude + wave.timescale?.unit, { vcd: true });
  if (
    !wave.signals.length ||
    wave.signals.length > limits.signals ||
    !wave.events.length ||
    wave.events.length > limits.samples ||
    wave.signals.length * wave.events.length > limits.cells
  )
    throw new Error("Waveform exceeds signal/sample limits.");
  const declarations = new Map();
  for (const signal of wave.signals) {
    if (
      typeof signal.id !== "string" ||
      !signal.id ||
      signal.id.length > 512 ||
      /[\s\x00-\x1f\x7f-\x9f]/.test(signal.id) ||
      declarations.has(signal.id) ||
      !Number.isInteger(signal.width) ||
      signal.width < 1 ||
      signal.width > limits.width
    )
      throw new Error("Invalid waveform signal.");
    declarations.set(signal.id, signal);
  }
  let prior = -1n;
  for (const event of wave.events) {
    if (
      typeof event.time !== "string" ||
      !decimal.test(event.time) ||
      BigInt(event.time) <= prior ||
      !event.changes ||
      typeof event.changes !== "object" ||
      Array.isArray(event.changes)
    )
      throw new Error(
        "Waveform requires increasing integer timestamps and changes.",
      );
    for (const [id, bits] of Object.entries(event.changes)) {
      const signal = declarations.get(id);
      if (
        !signal ||
        typeof bits !== "string" ||
        bits.length !== signal.width ||
        normalizeBits(bits, signal.width) !== bits
      )
        throw new Error("Invalid waveform change for " + id);
    }
    prior = BigInt(event.time);
  }
  return wave;
}

export function waveformVCD(wave) {
  validateWaveform(wave);
  const codes = new Map(wave.signals.map((s, i) => [s.id, "v" + i]));
  const lines = [
    "$version ChipSim waveform replay $end",
    `$timescale ${wave.timescale.magnitude}${wave.timescale.unit} $end`,
    ...wave.signals.map(
      (s) => `$var wire ${s.width} ${codes.get(s.id)} \\${s.id} $end`,
    ),
    "$enddefinitions $end",
  ];
  for (const [i, event] of wave.events.entries()) {
    lines.push("#" + event.time);
    if (!i)
      for (const s of wave.signals)
        if (!Object.hasOwn(event.changes, s.id))
          lines.push("b" + "x".repeat(s.width) + " " + codes.get(s.id));
    for (const [id, bits] of Object.entries(event.changes))
      lines.push("b" + bits.toLowerCase() + " " + codes.get(id));
  }
  return lines.join("\n") + "\n";
}
