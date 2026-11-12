import { HDLRecording, debugLimits } from "../hdl/debug/recording.js";
import { parseVCD, validateWaveform } from "../hdl/vcd.js";
import { json } from "../design/store.js";
import { verifyEvidence } from "../design/evidence.js";
import { readFile } from "node:fs/promises";
import { problem } from "./files.js";

export function page(items, offset = 0, limit = 100) {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}
export function recordingGraph(recording) {
  return {
    abstraction: "elaborated-rtl",
    objects: recording.data.design.objects,
    connections: recording.data.design.connections,
    sources: recording.data.sources,
    recording,
    capabilities: {
      ...recording.data.capabilities,
      nextState: "unsupported",
      connectivity: "static; does not identify an observed writer",
    },
  };
}
export function netlistGraph(data) {
  if (!data?.modules || typeof data.modules !== "object")
    throw problem("UNSUPPORTED_ARTIFACT", "Expected Yosys JSON modules");
  const objects = [],
    connections = [];
  const add = (item) => {
    objects.push(item);
    if (objects.length > debugLimits.objects)
      throw problem(
        "GRAPH_LIMIT",
        "Netlist exceeds 16384 objects; export a scoped netlist",
      );
  };
  const edge = (from, to, kind, bits) => {
    connections.push({ id: "y:e:" + connections.length, from, to, kind, bits });
    if (connections.length > debugLimits.connections)
      throw problem("GRAPH_LIMIT", "Netlist exceeds 65536 connections");
  };
  for (const [name, module] of Object.entries(data.modules)) {
    const base = "y:" + encodeURIComponent(name),
      bitIds = new Map();
    add({ id: base, kind: "module", label: name, path: name });
    const bits = (list) => {
      if (!Array.isArray(list))
        throw problem("INVALID_NETLIST", "Port/net bits must be arrays");
      return list.map((bit) => {
        if (
          !(Number.isSafeInteger(bit) && bit >= 0) &&
          !["0", "1", "x", "z"].includes(bit)
        )
          throw problem("INVALID_NETLIST", "Invalid Yosys bit");
        const key = typeof bit + ":" + bit;
        if (!bitIds.has(key)) {
          const id = base + "/bit/" + key;
          add({
            id,
            kind: typeof bit === "number" ? "net" : "constant",
            label: String(bit),
            parent: base,
            width: 1,
            observed: false,
          });
          bitIds.set(key, id);
        }
        return bitIds.get(key);
      });
    };
    for (const [name, port] of Object.entries(module.ports || {})) {
      const id = base + "/port/" + encodeURIComponent(name),
        nodes = bits(port.bits);
      add({
        id,
        kind: "port",
        label: name,
        parent: base,
        width: nodes.length,
        direction: port.direction,
        observed: false,
      });
      nodes.forEach((bit, i) =>
        edge(
          port.direction === "output" ? bit : id,
          port.direction === "output" ? id : bit,
          port.direction === "inout" ? "bidirectional" : "port",
          [i],
        ),
      );
    }
    for (const [name, net] of Object.entries(module.netnames || {})) {
      const id = base + "/bus/" + encodeURIComponent(name),
        nodes = bits(net.bits);
      add({
        id,
        kind: "bus",
        label: name,
        parent: base,
        width: nodes.length,
        observed: false,
        nativeSource: net.attributes?.src,
      });
      nodes.forEach((bit, i) => edge(id, bit, "alias", [i]));
    }
    for (const [name, cell] of Object.entries(module.cells || {})) {
      const id = base + "/cell/" + encodeURIComponent(name);
      add({
        id,
        kind: "cell",
        label: name,
        parent: base,
        type: cell.type,
        observed: false,
        nativeSource: cell.attributes?.src,
      });
      for (const [port, list] of Object.entries(cell.connections || {})) {
        const direction = cell.port_directions?.[port];
        bits(list).forEach((bit, i) =>
          edge(
            direction === "output" ? id : bit,
            direction === "output" ? bit : id,
            direction === "output"
              ? "drives"
              : direction === "input"
                ? "reads"
                : "direction-unknown",
            [{ port, index: i }],
          ),
        );
      }
    }
  }
  return {
    abstraction: "synthesized-module-definitions",
    objects,
    connections,
    sources: [],
    capabilities: {
      nextState: "unsupported",
      signalUpdates: false,
      connectivity: "static; module definitions are not a simulated hierarchy",
    },
  };
}
export async function inspectModel(store, id) {
  const artifact = await verifyEvidence(store, id);
  if (artifact.format !== "chipsim-artifact")
    throw problem("UNSUPPORTED_ARTIFACT", "Select an artifact ID");
  if (artifact.payload.bytes > debugLimits.fileBytes)
    throw problem("FILE_LIMIT", "Inspection payload exceeds 96 MiB");
  const path = store.blobPath(artifact.payload.sha256);
  let data;
  if (artifact.path.endsWith(".vcd"))
    data = parseVCD(await readFile(path, "utf8"));
  else data = await json(path, debugLimits.fileBytes);
  if (data.format === "chipsim-hdl-debug-session") data = data.recording;
  if (data.format === "chipsim-hdl-debug")
    return { ...recordingGraph(new HDLRecording(data)), artifact };
  if (data.format === "chipsim-waveform-session") data = data.waveform;
  if (data.format === "chipsim-waveform") {
    const wave = validateWaveform(data);
    return {
      artifact,
      abstraction: "recorded-waveform",
      objects: wave.signals.map((s) => ({
        ...s,
        kind: "signal",
        label: s.id,
        observed: true,
      })),
      connections: [],
      sources: [],
      wave,
      capabilities: {
        signalUpdates: true,
        nextState: "unsupported",
        connectivity: "unavailable",
        processActivations: false,
      },
    };
  }
  if (data.modules) return { ...netlistGraph(data), artifact };
  throw problem(
    "UNSUPPORTED_ARTIFACT",
    "Hardware inspection supports HDL debug, waveform and Yosys JSON artifacts; inspect other reports as evidence",
  );
}
export function graphWindow(
  model,
  { object, query = "", offset = 0, limit = 100, relation = "objects" } = {},
) {
  const selected = object && model.objects.find((o) => o.id === object);
  if (object && !selected)
    throw problem("UNKNOWN_OBJECT", "Object ID is not in this artifact");
  let items;
  if (relation === "objects")
    items = model.objects.filter(
      (o) =>
        (!object || o.parent === object) &&
        [o.id, o.label, o.path].some((s) => s?.includes(query)),
    );
  else
    items = model.connections.filter(
      (c) =>
        !object ||
        (relation === "fanin"
          ? c.to === object
          : relation === "fanout"
            ? c.from === object
            : c.from === object || c.to === object),
    );
  return {
    abstraction: model.abstraction,
    capabilities: model.capabilities,
    selected,
    ...page(items, offset, limit),
  };
}
export function traceWindow(
  model,
  { offset = 0, limit = 50, object, kind, at } = {},
) {
  if (object && !model.objects.some((o) => o.id === object))
    throw problem("UNKNOWN_OBJECT", "Unknown signal or process ID");
  const events = model.recording?.data.events || model.wave?.events;
  if (!events)
    throw problem("UNSUPPORTED_QUERY", "This artifact has no recorded events");
  if (at !== undefined && at >= events.length)
    throw problem("EVENT_RANGE", "Event index is outside this recording");
  const filtered = events
    .map((event, index) => ({ ...event, seq: index }))
    .filter(
      (e) =>
        (!kind || e.kind === kind) &&
        (!object ||
          Object.hasOwn(e.changes || {}, object) ||
          e.process === object ||
          e.writer === object),
    );
  let values;
  if (at !== undefined) {
    if (model.recording) values = model.recording.valuesAt(at);
    else {
      values = Object.create(null);
      for (let i = 0; i <= at; i++) Object.assign(values, events[i].changes);
    }
    if (object) values = { [object]: values[object] ?? null };
  }
  return {
    ...page(filtered, offset, limit),
    at,
    values,
    timescale: model.recording?.data.timescale || model.wave?.timescale,
    capture: model.recording?.data.status || {
      complete: null,
      reason: "Waveform does not establish capture completion",
    },
    capabilities: model.capabilities,
  };
}

// Shared text projection: no invented layout, storage classification or logic.
export function schematicLines(model, { object, at = 0, limit = 20 } = {}) {
  const selected =
    model.objects.find((o) => o.id === object) || model.objects[0];
  if (!selected) return ["No captured hardware objects"];
  const values = model.recording?.valuesAt(at) || {};
  const label = (id) => {
    const o = model.objects.find((o) => o.id === id);
    return `[${o?.kind || "?"} ${o?.label || id}${o?.width ? " :" + o.width : ""}] {${id}}${values[id] !== undefined ? " = " + values[id] : ""}`;
  };
  const edges = model.connections.filter(
    (e) => e.from === selected.id || e.to === selected.id,
  );
  const children = model.objects.filter((o) => o.parent === selected.id);
  const rows = [
    label(selected.id),
    ...children.map((o) => "  +-- " + label(o.id)),
    ...edges.map((e) => `${label(e.from)} --${e.kind}--> ${label(e.to)}`),
  ];
  const remaining = rows.length - limit;
  return [
    ...rows.slice(0, Math.max(1, limit - (remaining > 0 ? 1 : 0))),
    ...(remaining > 0
      ? [
          `… graph truncated; ${rows.length} rows total. Select a block or query connections.`,
        ]
      : []),
  ];
}
