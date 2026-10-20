import { timeScale } from "./time.js";

export const environmentSourceName = "chipsim_environment.sv";

const maxTick = 1000000000;
const maxEndpoints = 20000;
const maxSourceBytes = 4 * 1024 * 1024;
const rngId = "xorshift32-rejection-v1";
const keywords = new Set(
  `accept_on alias always always_comb always_ff always_latch and assert assign
  assume automatic before begin bind bins binsof bit break buf bufif0 bufif1 byte
  case casex casez cell chandle checker class clocking cmos config const constraint
  context continue cover covergroup coverpoint cross deassign default defparam
  design disable dist do edge else end endcase endchecker endclass endclocking
  endconfig endfunction endgenerate endgroup endinterface endmodule endpackage
  endprimitive endprogram endproperty endsequence endspecify endtable endtask enum
  event eventually expect export extends extern final first_match for force foreach
  forever fork forkjoin function generate genvar global highz0 highz1 if iff ifnone
  ignore_bins illegal_bins implements implies import incdir include initial inout
  input inside int integer interconnect interface intersect join join_any join_none
  large let liblist library local localparam logic longint macromodule matches
  medium modport module nand negedge nettype new nexttime nmos nor noshowcancelled
  not notif0 notif1 null or output package packed parameter pmos posedge primitive
  priority program property protected pull0 pull1 pulldown pullup
  pulsestyle_ondetect pulsestyle_onevent pure rand randc randcase randsequence rcmos
  real realtime ref reg reject_on release repeat restrict return rnmos rpmos rtran
  rtranif0 rtranif1 s_always s_eventually s_nexttime s_until s_until_with scalared
  sequence shortint shortreal showcancelled signed small soft solve specify
  specparam static string strong strong0 strong1 struct super supply0 supply1
  sync_accept_on sync_reject_on table tagged task this throughout time timeprecision
  timeunit tran tranif0 tranif1 tri tri0 tri1 triand trior trireg type typedef union
  unique unique0 unsigned until until_with untyped use uwire var vectored virtual
  void wait wait_order wand weak weak0 weak1 while wildcard wire with within wor
  xnor xor`.split(/\s+/),
);

function record(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be an object.");
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error("Unknown " + label + " field " + key + ".");
  for (const key of required)
    if (!Object.hasOwn(value, key))
      throw new Error(label + " requires " + key + ".");
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(
      label + " must be an integer from " + min + " to " + max + ".",
    );
  return value;
}

function bit(value, label) {
  if (value !== 0 && value !== 1) throw new Error(label + " must be 0 or 1.");
  return value;
}

function normalize(profile) {
  const fields = ["format", "version", "timeUnit", "seed", "channels"];
  record(profile, fields, fields, "environment");
  if (profile.format !== "chipsim-digital-environment" || profile.version !== 1)
    throw new Error("Expected a version-1 chipsim-digital-environment.");
  if (typeof profile.timeUnit !== "string")
    throw new Error("environment timeUnit must be a string.");
  const scale = timeScale(profile.timeUnit, { vcd: true });
  const seed = integer(profile.seed, 1, 0xffffffff, "environment seed");
  if (
    !Array.isArray(profile.channels) ||
    !profile.channels.length ||
    profile.channels.length > 16
  )
    throw new Error("environment requires 1–16 channels.");
  const channels = [],
    names = new Set();
  let endpoints = 0;
  for (const [index, channel] of profile.channels.entries()) {
    const label = "channel " + index;
    record(
      channel,
      [
        "name",
        "initial",
        "delayTicks",
        "offsetTicks",
        "jitterTicks",
        "events",
        "glitches",
      ],
      ["name", "initial", "events", "glitches"],
      label,
    );
    if (
      typeof channel.name !== "string" ||
      channel.name.length > 128 ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(channel.name) ||
      keywords.has(channel.name)
    )
      throw new Error(
        label +
          " name must be a simple nonreserved HDL identifier (at most 128 characters).",
      );
    if (names.has(channel.name))
      throw new Error("Duplicate environment channel " + channel.name + ".");
    names.add(channel.name);
    const initial = bit(channel.initial, label + " initial");
    const delayTicks = integer(
      Object.hasOwn(channel, "delayTicks") ? channel.delayTicks : 0,
      0,
      maxTick,
      label + " delayTicks",
    );
    const offsetTicks = integer(
      Object.hasOwn(channel, "offsetTicks") ? channel.offsetTicks : 0,
      -maxTick,
      maxTick,
      label + " offsetTicks",
    );
    const jitterTicks = integer(
      Object.hasOwn(channel, "jitterTicks") ? channel.jitterTicks : 0,
      0,
      maxTick,
      label + " jitterTicks",
    );
    if (delayTicks + offsetTicks - jitterTicks < 0)
      throw new Error(
        label +
          " delay support cannot advance an edge before its requested tick.",
      );
    if (delayTicks + offsetTicks + jitterTicks > maxTick)
      throw new Error(label + " delay support exceeds " + maxTick + " ticks.");
    if (!Array.isArray(channel.events) || channel.events.length > 256)
      throw new Error(label + " events must be an array of at most 256 edges.");
    if (!Array.isArray(channel.glitches))
      throw new Error(label + " glitches must be an array.");
    endpoints += 2 * (channel.events.length + channel.glitches.length);
    if (endpoints > maxEndpoints)
      throw new Error(
        "environment exceeds " + maxEndpoints + " timeline endpoints.",
      );
    const events = [],
      glitches = [];
    let previousTick = 0,
      previousValue = initial;
    for (const event of channel.events) {
      record(event, ["tick", "value"], ["tick", "value"], label + " event");
      const tick = integer(event.tick, 1, maxTick, label + " event tick");
      const value = bit(event.value, label + " event value");
      if (tick <= previousTick)
        throw new Error(label + " event ticks must be strictly increasing.");
      if (value === previousValue)
        throw new Error(
          label + " events must alternate from initial without no-op edges.",
        );
      events.push({ tick, value });
      previousTick = tick;
      previousValue = value;
    }
    for (const glitch of channel.glitches) {
      record(
        glitch,
        ["tick", "durationTicks"],
        ["tick", "durationTicks"],
        label + " glitch",
      );
      const tick = integer(glitch.tick, 1, maxTick, label + " glitch tick");
      const durationTicks = integer(
        glitch.durationTicks,
        1,
        maxTick,
        label + " glitch durationTicks",
      );
      if (tick + durationTicks > maxTick)
        throw new Error(label + " glitch end tick exceeds " + maxTick + ".");
      glitches.push({ tick, durationTicks });
    }
    const ordered = [...glitches].sort((a, b) => a.tick - b.tick);
    for (let i = 1; i < ordered.length; i++)
      if (ordered[i].tick < ordered[i - 1].tick + ordered[i - 1].durationTicks)
        throw new Error(
          label + " glitches must not overlap (half-open intervals).",
        );
    channels.push({
      name: channel.name,
      initial,
      delayTicks,
      offsetTicks,
      jitterTicks,
      events,
      glitches,
    });
  }
  return {
    format: "chipsim-digital-environment",
    version: 1,
    timeUnit: scale.magnitude + scale.unit,
    seed,
    channels,
  };
}

// xorshift32 has 2^32-1 nonzero states. Subtract one before rejection sampling
// so every accepted residue has the same number of states. Even range 1 draws.
function random(seed) {
  let state = seed,
    draws = 0;
  const rejections = [];
  return {
    sample(range, channel, bit, eventIndex) {
      const limit = Math.floor(0xffffffff / range) * range;
      const before = draws;
      let candidate;
      do {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        draws++;
        candidate = state - 1;
        if (candidate >= limit)
          rejections.push({ channel, bit, eventIndex, state });
      } while (candidate >= limit);
      return {
        value: candidate % range,
        rngDraws: draws - before,
        rngState: state,
      };
    },
    report() {
      return {
        id: rngId,
        algorithm: "xorshift32(13,17,5)",
        sampling:
          "state-1 in [0,4294967294]; reject >= floor(4294967295/range)*range; modulo range",
        drawOrder:
          "channel array, then event array; at least one draw per event, including zero jitter",
        draws,
        rejections,
      };
    },
  };
}

export function generateEnvironment(input) {
  const profile = normalize(input),
    rng = random(profile.seed);
  const edges = [],
    endpoints = new Map();
  const add = (tick, change) => {
    if (!endpoints.has(tick)) endpoints.set(tick, []);
    endpoints.get(tick).push(change);
  };
  for (const [bit, channel] of profile.channels.entries()) {
    let previousArrival = 0;
    for (const [eventIndex, event] of channel.events.entries()) {
      const sample = rng.sample(
        2 * channel.jitterTicks + 1,
        channel.name,
        bit,
        eventIndex,
      );
      const jitterTicks = sample.value - channel.jitterTicks;
      const delayTicks = channel.delayTicks + channel.offsetTicks + jitterTicks;
      const arrivalTick = event.tick + delayTicks;
      if (arrivalTick > maxTick)
        throw new Error(
          "channel " + channel.name + " arrival tick exceeds " + maxTick + ".",
        );
      if (arrivalTick <= previousArrival)
        throw new Error(
          "channel " +
            channel.name +
            " delayed arrivals collide or reorder; arrival ticks must be strictly increasing.",
        );
      previousArrival = arrivalTick;
      edges.push({
        channel: channel.name,
        bit,
        eventIndex,
        requestedTick: event.tick,
        value: event.value,
        jitterTicks,
        delayTicks,
        arrivalTick,
        rngDraws: sample.rngDraws,
        rngState: sample.rngState,
      });
      add(event.tick, { kind: "nominal", bit, value: event.value });
      add(arrivalTick, { kind: "base", bit, value: event.value });
    }
    for (const glitch of channel.glitches) {
      add(glitch.tick, { kind: "glitch", bit });
      add(glitch.tick + glitch.durationTicks, { kind: "glitch", bit });
    }
  }
  const nominal = profile.channels.map((channel) => channel.initial);
  const base = [...nominal],
    glitches = nominal.map(() => 0);
  const bits = (values) => [...values].reverse().join("");
  const frame = (tick) => ({
    tick,
    nominal: bits(nominal),
    disturbed: bits(base.map((value, bit) => value ^ glitches[bit])),
  });
  const frames = [frame(0)];
  for (const tick of [...endpoints.keys()].sort((a, b) => a - b)) {
    for (const change of endpoints.get(tick)) {
      if (change.kind === "nominal") nominal[change.bit] = change.value;
      else if (change.kind === "base") base[change.bit] = change.value;
      else glitches[change.bit] ^= 1;
    }
    frames.push(frame(tick));
  }
  const width = profile.channels.length;
  const lines = [
    "`timescale " + profile.timeUnit + "/" + profile.timeUnit,
    "module chipsim_environment(",
    "  output reg [" + (width - 1) + ":0] nominal,",
    "  output reg [" + (width - 1) + ":0] disturbed",
    ");",
    "  // Digital test scenario: integer delays and XOR glitches, not analog behavior.",
    "  initial begin",
  ];
  let previousTick = 0;
  for (const current of frames) {
    if (current.tick) lines.push("    #" + (current.tick - previousTick) + ";");
    lines.push(
      "    {nominal, disturbed} = " +
        2 * width +
        "'b" +
        current.nominal +
        current.disturbed +
        ";",
    );
    previousTick = current.tick;
  }
  lines.push("  end", "endmodule", "");
  const source = lines.join("\n");
  if (Buffer.byteLength(source, "utf8") > maxSourceBytes)
    throw new Error("Generated environment source exceeds 4 MiB.");
  return {
    source,
    report: {
      format: "chipsim-environment-result",
      version: 1,
      profile,
      channelBits: profile.channels.map((channel, bit) => ({
        name: channel.name,
        bit,
      })),
      seed: profile.seed,
      rng: rng.report(),
      edges,
      frames,
    },
  };
}
