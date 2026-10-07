import { operators, ModelError, validateModel } from "./validate.js";

export function evaluate(expr, context) {
  if (typeof expr === "string") {
    if (expr === "tick") return context.tick;
    if (expr === "stateAge") return context.tick - context.entered;
    const match = /^(param|reg|signal)\.(.+)$/.exec(expr);
    return match
      ? context[
          { param: "parameters", reg: "registers", signal: "signals" }[match[1]]
        ][match[2]]
      : expr;
  }
  if (!expr || typeof expr !== "object") return expr;
  if (!operators.has(expr.op)) throw new Error(`Unknown operator ${expr.op}`);
  const [a, b] = expr.args.map((arg) => evaluate(arg, context));
  switch (expr.op) {
    case "add":
      return a + b;
    case "sub":
      return a - b;
    case "mul":
      return a * b;
    case "div":
      if (!b) throw new Error("Division by zero");
      return Math.floor(a / b);
    case "mod":
      if (!b) throw new Error("Modulo by zero");
      return a % b;
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "lt":
      return a < b;
    case "le":
      return a <= b;
    case "gt":
      return a > b;
    case "ge":
      return a >= b;
    case "and":
      return Boolean(a && b);
    case "or":
      return Boolean(a || b);
    case "not":
      return !a;
    case "bitAnd":
      return (a & b) >>> 0;
    case "bitOr":
      return (a | b) >>> 0;
    case "bitXor":
      return (a ^ b) >>> 0;
    case "shiftLeft":
      return (a << b) >>> 0;
    case "shiftRight":
      return a >>> b;
  }
}

export function normalizeParameters(definitions, supplied = {}) {
  const result = Object.create(null);
  for (const definition of definitions) {
    const value = supplied[definition.id] ?? definition.default;
    if (
      definition.type === "integer" &&
      (!Number.isSafeInteger(value) ||
        value < definition.min ||
        value > definition.max)
    )
      throw new Error(
        `${definition.label || definition.id} must be an integer from ${definition.min} to ${definition.max}`,
      );
    if (definition.type === "boolean" && typeof value !== "boolean")
      throw new Error(`${definition.id} must be true or false`);
    if (definition.type === "enum" && !definition.options.includes(value))
      throw new Error(
        `${definition.id} must be one of ${definition.options.join(", ")}`,
      );
    result[definition.id] = value;
  }
  for (const key of Object.keys(supplied))
    if (!definitions.some((p) => p.id === key))
      throw new Error(`Unknown parameter ${key}`);
  return result;
}

export function validateInputs(signals, inputs) {
  if (!Array.isArray(inputs) || inputs.length > 10000)
    throw new Error("Input events must be an array with at most 10000 entries");
  return inputs
    .map((event) => {
      const signal = signals.find(
        (signal) => signal.id === event.signal && signal.direction === "input",
      );
      if (!signal) throw new Error(`Unknown input signal ${event.signal}`);
      if (
        !Number.isSafeInteger(event.tick) ||
        event.tick < 0 ||
        event.tick > 10000
      )
        throw new Error("Input event tick must be between 0 and 10000");
      if (
        !Number.isSafeInteger(event.value) ||
        event.value < 0 ||
        event.value >= 2 ** signal.width
      )
        throw new Error(
          `Invalid ${signal.width}-bit input value for ${signal.id}`,
        );
      return { tick: event.tick, signal: event.signal, value: event.value };
    })
    .sort((a, b) => a.tick - b.tick);
}

export function changesBetween(previous, current) {
  const changes = [];
  for (const kind of ["signals", "registers"])
    for (const [id, value] of Object.entries(current[kind] || {}))
      if (previous?.[kind]?.[id] !== value)
        changes.push({
          kind,
          id,
          before: previous?.[kind]?.[id] ?? null,
          after: value,
        });
  if (previous && previous.state !== current.state)
    changes.unshift({
      kind: "state",
      id: "state",
      before: previous.state,
      after: current.state,
    });
  return changes;
}

export function simulateModel(model, supplied = {}, options = {}) {
  validateModel(model);
  const ticks = options.ticks ?? model.duration ?? 100;
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10000)
    throw new Error("Duration must be 1-10000 ticks");
  const inputs = validateInputs(model.signals, options.inputs || []),
    states = new Map(model.states.map((s) => [s.id, s]));
  const context = {
    tick: 0,
    entered: 0,
    parameters: normalizeParameters(model.parameters, supplied),
    registers: Object.fromEntries(
      model.registers.map((r) => [r.id, r.initial]),
    ),
    signals: Object.fromEntries(model.signals.map((s) => [s.id, s.initial])),
  };
  let state = states.get(model.initialState),
    inputIndex = 0,
    fault = null,
    message = "",
    evidence = [],
    active = [];
  const execute = (actions) => {
    for (const action of actions) {
      if (action.log !== undefined) {
        message = action.log;
        continue;
      }
      const [kind, id] = action.target.split("."),
        definitions = kind === "reg" ? model.registers : model.signals;
      const width = definitions.find((item) => item.id === id).width,
        value = evaluate(action.value, context);
      if (!Number.isSafeInteger(value) && typeof value !== "boolean")
        throw new Error(`${action.target}: result is not a safe integer`);
      context[kind === "reg" ? "registers" : "signals"][id] =
        ((Number(value) % 2 ** width) + 2 ** width) % 2 ** width;
    }
  };
  const trace = [];
  for (let tick = 0; tick <= ticks; tick++) {
    context.tick = tick;
    message = "";
    evidence = [];
    active = state.active || [];
    while (inputIndex < inputs.length && inputs[inputIndex].tick === tick) {
      const event = inputs[inputIndex++];
      context.signals[event.signal] = event.value;
    }
    try {
      if (tick === 0) {
        execute(state.entry);
        message ||= "Initial state";
      } else if (!state.terminal && !fault) {
        execute(state.tick);
        const transition = state.transitions.find((transition) =>
          evaluate(transition.when, context),
        );
        if (transition) {
          execute(transition.actions);
          state = states.get(transition.to);
          context.entered = tick;
          execute(state.entry);
          message =
            transition.message || message || `Enter ${state.label || state.id}`;
          evidence = transition.evidence || [];
          active = transition.active || state.active || [];
        }
      }
    } catch (error) {
      fault = error.message;
      message = fault;
    }
    const snapshot = {
      tick,
      state: state.id,
      phase: fault ? "fault" : state.terminal ? "complete" : "running",
      signals: { ...context.signals },
      registers: { ...context.registers },
      active,
      values: {},
      message,
      detail: fault || "",
      evidence,
    };
    snapshot.changes = changesBetween(trace.at(-1), snapshot);
    trace.push(snapshot);
    if (fault) break;
  }
  return trace;
}

export function runChecks(model) {
  return (model.checks || []).map((check, index) => {
    try {
      const trace = simulateModel(model, check.parameters || {}, {
          ticks: check.ticks,
          inputs: check.inputs || [],
        }),
        last = trace.at(-1);
      if (last.phase === "fault") throw new Error(last.detail);
      for (const [key, expected] of Object.entries(check.expect || {})) {
        const actual =
          key === "state"
            ? last.state
            : key.startsWith("signal.")
              ? last.signals[key.slice(7)]
              : key.startsWith("reg.")
                ? last.registers[key.slice(4)]
                : undefined;
        if (actual !== expected)
          throw new Error(`${key}: expected ${expected}, got ${actual}`);
      }
      if (!Object.keys(check.expect || {}).length)
        throw new Error(
          "Acceptance case needs expected state, register, or signal values",
        );
      return { name: check.name || `Case ${index + 1}`, passed: true };
    } catch (error) {
      return {
        name: check.name || `Case ${index + 1}`,
        passed: false,
        error: error.message,
      };
    }
  });
}
