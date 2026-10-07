import * as pio from "./builtins/pio.js";
import * as pru from "./builtins/pru.js";
import * as flexio from "./builtins/flexio.js";
import * as udb from "./builtins/udb.js";
import * as xmos from "./builtins/xmos.js";
import * as etpu from "./builtins/etpu.js";
import { normalize, frameEnd } from "../core/protocol.js";
import { recipe } from "./recipes.js";
import {
  changesBetween,
  normalizeParameters,
  simulateModel,
  validateInputs,
  runChecks,
} from "../model/engine.js";
import { validateModel } from "../model/validate.js";
import references from "../../docs/references/manifest.json" with { type: "json" };

const integer = (id, label, value, min, max, advanced = false) => ({
  id,
  label,
  type: "integer",
  default: value,
  min,
  max,
  advanced,
});
const parameters = [
  integer("payload", "Payload", 179, 0, 0xffffffff),
  {
    id: "bits",
    label: "Frame bits",
    type: "enum",
    options: ["8", "12"],
    default: "8",
  },
  integer("half", "Clock half-period", 2, 1, 6),
  {
    id: "ack",
    label: "ACK",
    type: "enum",
    options: ["present", "missing"],
    default: "present",
  },
  {
    id: "stress",
    label: "Resource constraint",
    type: "boolean",
    default: false,
    advanced: true,
  },
  integer("budget", "ACK budget", 8, 1, 32, true),
  integer("ackDelay", "ACK arrival delay", 3, 0, 32, true),
];

export const builtinModels = Object.entries({
  pio,
  pru,
  flexio,
  udb,
  xmos,
  etpu,
}).map(([id, module]) => ({
  id,
  kind: "builtin",
  name: module.metadata.name,
  summary: module.metadata.summary,
  scope: module.metadata.fixed,
  fidelity: "behavioral",
  parameters,
  signals: [
    { id: "data", label: "DATA", width: 1, direction: "output", initial: 0 },
    { id: "clock", label: "CLK", width: 1, direction: "output", initial: 0 },
    { id: "ack", label: "ACK", width: 1, direction: "input", initial: 0 },
  ],
  metadata: module.metadata,
  topology: module.topology,
  sources: references.documents
    .filter((document) => document.chips.includes(id))
    .map((document) => ({
      ...document,
      id: document.path,
      href: document.path + "#page=" + document.pdf_start_page,
    })),
  assumptions: [
    module.metadata.notes,
    "Ticks summarize semantic operations and are not silicon cycles.",
  ],
  simulate(supplied, options = {}) {
    const params = normalizeParameters(parameters, supplied),
      inputs = validateInputs(this.signals, options.inputs || []);
    const config = normalize({
      ...params,
      bits: Number(params.bits),
      inputEvents: inputs,
    });
    const trace = module.simulate(config).map((s) => {
      const registers = Object.fromEntries(
        Object.entries(s).filter(
          ([key, value]) =>
            typeof value === "number" &&
            !["t", "data", "clock", "ack"].includes(key),
        ),
      );
      return {
        tick: s.t,
        state: s.phase,
        phase: s.phase,
        signals: { data: s.data, clock: s.clock, ack: s.ack },
        registers,
        active: s.active,
        values: s.values,
        message: s.event,
        detail: s.detail,
        evidence: [],
        recipeLine: s.line,
        original: s,
      };
    });
    trace.forEach(
      (snapshot, index) =>
        (snapshot.changes = changesBetween(trace[index - 1], snapshot)),
    );
    return trace;
  },
  recipe(params) {
    return recipe(id, normalize({ ...params, bits: Number(params.bits) }));
  },
  expectedEnd(params) {
    return frameEnd(normalize({ ...params, bits: Number(params.bits) }));
  },
}));

export function registerModel(spec, documents = []) {
  const { warnings } = validateModel(spec, documents);
  if (builtinModels.some((model) => model.id === spec.id))
    throw new Error(`Model ID ${spec.id} is reserved for a built-in example`);
  const checks = runChecks(spec),
    failed = checks.filter((check) => !check.passed);
  if (failed.length)
    throw new Error(
      "Acceptance checks failed: " +
        failed.map((check) => check.name + ": " + check.error).join("; "),
    );
  return {
    ...spec,
    kind: "document",
    spec,
    warnings,
    checks,
    simulate(parameters, options) {
      return simulateModel(spec, parameters, options);
    },
    topology: {
      nodes: spec.nodes,
      edges: spec.edges.map((edge) => [edge.from, edge.to]),
    },
    recipe() {
      return spec.states.map((state) => state.id + ": " + (state.label || ""));
    },
  };
}

export function defaultParameters(model) {
  return Object.fromEntries(
    model.parameters.map((parameter) => [parameter.id, parameter.default]),
  );
}
