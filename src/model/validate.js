const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export const operators = new Set([
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "and",
  "or",
  "not",
  "bitAnd",
  "bitOr",
  "bitXor",
  "shiftLeft",
  "shiftRight",
]);

export class ModelError extends Error {
  constructor(errors) {
    super(errors.join("\n"));
    this.name = "ModelError";
    this.errors = errors;
  }
}

export function validateModel(model, documents = []) {
  const errors = [],
    warnings = [];
  const fail = (path, message) => errors.push(`${path}: ${message}`);
  if (!model || typeof model !== "object" || Array.isArray(model))
    throw new ModelError(["model: expected an object"]);
  const id = (value, path) => {
    if (
      typeof value !== "string" ||
      !identifier.test(value) ||
      forbidden.has(value)
    )
      fail(path, "use a unique identifier starting with a letter");
  };
  if (model.schemaVersion !== 1) fail("schemaVersion", "must be 1");
  id(model.id, "id");
  for (const key of ["name", "summary", "scope"])
    if (
      typeof model[key] !== "string" ||
      !model[key].trim() ||
      model[key].length > 4000
    )
      fail(key, "required text, at most 4000 characters");
  if (model.fidelity !== "behavioral")
    fail(
      "fidelity",
      "must be behavioral; hardware accuracy is not inferred from a manual",
    );
  const definitions = {};
  const list = (key, limit, required = false) => {
    const array = model[key];
    if (
      !Array.isArray(array) ||
      array.length > limit ||
      (required && !array.length)
    ) {
      fail(key, `expected ${required ? "1" : "0"}-${limit} entries`);
      return [];
    }
    const seen = new Set();
    array.forEach((item, i) => {
      if (!item || typeof item !== "object") {
        fail(`${key}[${i}]`, "expected an object");
        return;
      }
      id(item.id, `${key}[${i}].id`);
      if (seen.has(item.id)) fail(`${key}[${i}].id`, "duplicate");
      seen.add(item.id);
    });
    definitions[key] = new Map(
      array.filter((x) => x && typeof x === "object").map((x) => [x.id, x]),
    );
    return array.filter((x) => x && typeof x === "object");
  };
  const parameters = list("parameters", 32),
    signals = list("signals", 32, true),
    registers = list("registers", 128),
    nodes = list("nodes", 32, true),
    states = list("states", 64, true),
    sources = list("sources", 32, true),
    evidence = list("evidence", 256, true);
  const number = (value, path, min, max) => {
    if (!Number.isSafeInteger(value) || value < min || value > max)
      fail(path, `expected an integer from ${min} to ${max}`);
  };
  for (const parameter of parameters) {
    const path = `parameters.${parameter.id}`;
    if (!["integer", "boolean", "enum"].includes(parameter.type))
      fail(path + ".type", "use integer, boolean, or enum");
    if (parameter.type === "integer") {
      number(parameter.min, path + ".min", 0, 0xffffffff);
      number(parameter.max, path + ".max", parameter.min, 0xffffffff);
      number(
        parameter.default,
        path + ".default",
        parameter.min,
        parameter.max,
      );
    }
    if (parameter.type === "boolean" && typeof parameter.default !== "boolean")
      fail(path + ".default", "expected a boolean");
    if (
      parameter.type === "enum" &&
      (!Array.isArray(parameter.options) ||
        !parameter.options.length ||
        !parameter.options.every((x) => typeof x === "string") ||
        !parameter.options.includes(parameter.default))
    )
      fail(path + ".options", "must include the default string");
  }
  for (const [kind, items] of [
    ["signals", signals],
    ["registers", registers],
  ])
    for (const item of items) {
      number(item.width, `${kind}.${item.id}.width`, 1, 32);
      number(
        item.initial,
        `${kind}.${item.id}.initial`,
        0,
        2 ** item.width - 1,
      );
      if (kind === "signals" && !["input", "output"].includes(item.direction))
        fail(`signals.${item.id}.direction`, "use input or output");
    }
  const reference = (ref, path) => {
    if (ref === "tick" || ref === "stateAge") return;
    const match = /^(param|reg|signal)\.([a-zA-Z][\w-]*)$/.exec(ref);
    const kind =
      match &&
      { param: "parameters", reg: "registers", signal: "signals" }[match[1]];
    if (!kind || !definitions[kind]?.has(match[2]))
      fail(path, `unknown reference ${ref}`);
  };
  const expression = (expr, path, depth = 0) => {
    if (depth > 16) {
      fail(path, "expression exceeds nesting limit");
      return;
    }
    if (typeof expr === "number") {
      if (!Number.isFinite(expr)) fail(path, "expected a finite number");
      return;
    }
    if (typeof expr === "boolean") return;
    if (typeof expr === "string") {
      if (
        /^(param|reg|signal)\./.test(expr) ||
        ["tick", "stateAge"].includes(expr)
      )
        reference(expr, path);
      return;
    }
    if (
      !expr ||
      typeof expr !== "object" ||
      !operators.has(expr.op) ||
      !Array.isArray(expr.args)
    ) {
      fail(path, "expected a literal, reference, or {op,args}");
      return;
    }
    const arity = expr.op === "not" ? 1 : 2;
    if (expr.args.length !== arity)
      fail(path + ".args", `expected ${arity} arguments`);
    expr.args.forEach((arg, i) =>
      expression(arg, `${path}.args[${i}]`, depth + 1),
    );
  };
  const actions = (items, path) => {
    if (!Array.isArray(items) || items.length > 64) {
      fail(path, "expected an array of at most 64 actions");
      return;
    }
    items.forEach((action, i) => {
      if (!action || typeof action !== "object") {
        fail(`${path}[${i}]`, "expected an action");
        return;
      }
      if (typeof action.log === "string" && action.target === undefined) return;
      if (!/^(reg|signal)\./.test(action.target || ""))
        fail(
          `${path}[${i}].target`,
          "only registers and output signals can be assigned",
        );
      else {
        reference(action.target, `${path}[${i}].target`);
        const signal = definitions.signals?.get(action.target.slice(7));
        if (
          action.target.startsWith("signal.") &&
          signal?.direction === "input"
        )
          fail(`${path}[${i}].target`, "input signals are driven by stimulus");
      }
      expression(action.value, `${path}[${i}].value`);
    });
  };
  const refs = (items, kind, path) => {
    if (items === undefined) return;
    if (!Array.isArray(items) || items.length > 128) {
      fail(path, "expected an array of identifiers");
      return;
    }
    for (const key of items)
      if (!definitions[kind]?.has(key))
        fail(path, `unknown ${kind} reference ${key}`);
  };
  if (model.duration !== undefined)
    number(model.duration, "duration", 1, 10000);
  if (!definitions.states?.has(model.initialState))
    fail("initialState", "must name an existing state");
  for (const state of states) {
    refs(state.active, "nodes", `states.${state.id}.active`);
    if (state.terminal !== undefined && typeof state.terminal !== "boolean")
      fail(`states.${state.id}.terminal`, "expected a boolean");
    actions(state.entry, `states.${state.id}.entry`);
    actions(state.tick, `states.${state.id}.tick`);
    if (!Array.isArray(state.transitions) || state.transitions.length > 32) {
      fail(
        `states.${state.id}.transitions`,
        "expected an array of at most 32 transitions",
      );
      continue;
    }
    for (const [i, transition] of state.transitions.entries()) {
      if (!transition || typeof transition !== "object") {
        fail(`states.${state.id}.transitions[${i}]`, "expected an object");
        continue;
      }
      if (!definitions.states.has(transition.to))
        fail(`states.${state.id}.transitions[${i}].to`, "unknown target state");
      expression(transition.when, `states.${state.id}.transitions[${i}].when`);
      actions(
        transition.actions,
        `states.${state.id}.transitions[${i}].actions`,
      );
      refs(
        transition.evidence,
        "evidence",
        `states.${state.id}.transitions[${i}].evidence`,
      );
      refs(
        transition.active,
        "nodes",
        `states.${state.id}.transitions[${i}].active`,
      );
    }
  }
  if (!Array.isArray(model.edges) || model.edges.length > 128)
    fail("edges", "expected at most 128 edges");
  else
    for (const edge of model.edges)
      if (
        !edge ||
        !definitions.nodes?.has(edge.from) ||
        !definitions.nodes?.has(edge.to)
      )
        fail("edges", "edge must connect existing nodes");
  for (const node of nodes) {
    for (const key of ["x", "y", "w", "h"])
      if (node[key] !== undefined)
        number(
          node[key],
          `nodes.${node.id}.${key}`,
          key === "w" || key === "h" ? 1 : 0,
          4096,
        );
    refs(node.registers, "registers", `nodes.${node.id}.registers`);
    refs(node.signals, "signals", `nodes.${node.id}.signals`);
  }
  if (
    !Array.isArray(model.assumptions) ||
    !model.assumptions.length ||
    !model.assumptions.every((x) => typeof x === "string")
  )
    fail(
      "assumptions",
      "declare model assumptions as a non-empty string array",
    );
  if (
    !Array.isArray(model.checks) ||
    !model.checks.length ||
    model.checks.length > 64
  )
    fail("checks", "include 1-64 executable acceptance cases");
  for (const [i, check] of (Array.isArray(model.checks)
    ? model.checks
    : []
  ).entries()) {
    if (
      !check ||
      typeof check !== "object" ||
      !check.expect ||
      typeof check.expect !== "object" ||
      Array.isArray(check.expect) ||
      !Object.keys(check.expect).length
    ) {
      fail(`checks[${i}]`, "expected an acceptance case with nonempty expect");
      continue;
    }
    number(check.ticks, `checks[${i}].ticks`, 1, 10000);
    for (const key of Object.keys(check.expect))
      if (key !== "state") reference(key, `checks[${i}].expect`);
  }
  for (const source of sources)
    if (!/^[a-f0-9]{64}$/.test(source.sha256 || ""))
      fail(`sources.${source.id}.sha256`, "required PDF SHA-256");
  const normalize = (value) => String(value).replace(/\s+/g, " ").trim();
  for (const item of evidence) {
    const source = definitions.sources?.get(item.sourceId);
    if (!source) {
      fail(`evidence.${item.id}.sourceId`, "unknown source");
      continue;
    }
    number(item.page, `evidence.${item.id}.page`, 1, 100000);
    if (
      typeof item.quote !== "string" ||
      item.quote.length < 8 ||
      item.quote.length > 1000 ||
      typeof item.claim !== "string"
    )
      fail(
        `evidence.${item.id}`,
        "include a short exact quote and the supported claim",
      );
    const document = documents.find((doc) => doc.sha256 === source.sha256);
    if (document) {
      const page = document.pages?.find((page) => page.number === item.page);
      if (!page || !normalize(page.text).includes(normalize(item.quote)))
        fail(
          `evidence.${item.id}`,
          "quote does not occur on the stated PDF page",
        );
    } else
      warnings.push(
        `Evidence ${item.id}: attach ${source.filename || source.title || source.id} to verify the quote.`,
      );
  }
  if (errors.length) throw new ModelError(errors);
  return { model, warnings };
}
