// Original MIT implementation. Typed, finite, unsigned bit-vector expressions.
// These are data, never JavaScript/HDL text supplied for evaluation.
export const mask = (width) => (1n << BigInt(width)) - 1n;
export function width(value) {
  if (!Number.isInteger(value) || value < 1 || value > 64)
    throw new Error("Circuit widths must be integers in 1..64");
  return value;
}
export function fields(value, required, optional = []) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => ![...required, ...optional].includes(key),
    ) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Expected fields: " + required.join(", "));
}
export function literal(value, bits) {
  width(bits);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Expected an unsigned integer literal");
    value = String(value);
  }
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^(?:0|[1-9][0-9]*|0[bB][01]+|0[xX][0-9a-fA-F]+)$/.test(value)
  )
    throw new Error(
      "Expected a binary, hexadecimal or decimal integer; X/Z/uninitialized values are unsupported",
    );
  const result = BigInt(value);
  if (result > mask(bits))
    throw new Error("Literal does not fit its declared width");
  return result;
}
export const binary = (value, bits) => value.toString(2).padStart(bits, "0");

export function expression(value, ports, budget = { count: 0 }, depth = 0) {
  if (++budget.count > 4096 || depth > 32)
    throw new Error(
      "Circuit expression limit exceeded (4096 nodes / depth 32)",
    );
  if (Object.hasOwn(value || {}, "ref")) {
    fields(value, ["ref"]);
    if (typeof value.ref !== "string" || !Object.hasOwn(ports, value.ref))
      throw new Error(
        "Expression references undeclared/unavailable connected port: " +
          value.ref,
      );
    return { kind: "ref", ref: value.ref, width: ports[value.ref] };
  }
  if (Object.hasOwn(value || {}, "bits")) {
    fields(value, ["bits", "width"]);
    return {
      kind: "constant",
      width: width(value.width),
      bits: literal(value.bits, value.width),
    };
  }
  fields(value, ["op", "args"], ["high", "low"]);
  const arities = {
    not: 1,
    and: 2,
    or: 2,
    xor: 2,
    add: 2,
    sub: 2,
    eq: 2,
    ult: 2,
    mux: 3,
    slice: 1,
    concat: -1,
  };
  if (
    !Object.hasOwn(arities, value.op) ||
    !Array.isArray(value.args) ||
    (value.op === "concat"
      ? value.args.length < 1 || value.args.length > 16
      : value.args.length !== arities[value.op])
  )
    throw new Error("Unsupported circuit operator or wrong arity: " + value.op);
  if (
    value.op !== "slice" &&
    (Object.hasOwn(value, "high") || Object.hasOwn(value, "low"))
  )
    throw new Error("Only slice accepts high/low bounds");
  const args = value.args.map((arg) =>
    expression(arg, ports, budget, depth + 1),
  );
  let bits = args[0].width;
  if (value.op === "slice") {
    if (
      !Number.isInteger(value.low) ||
      !Number.isInteger(value.high) ||
      value.low < 0 ||
      value.high < value.low ||
      value.high >= bits
    )
      throw new Error("Slice bounds outside connected vector");
    bits = value.high - value.low + 1;
  } else if (value.op === "concat")
    bits = args.reduce((sum, arg) => sum + arg.width, 0);
  else if (value.op === "mux") {
    if (args[0].width !== 1 || args[1].width !== args[2].width)
      throw new Error("Mux needs a 1-bit selector and equal-width data paths");
    bits = args[1].width;
  } else if (args.length === 2) {
    if (args[0].width !== args[1].width)
      throw new Error("Circuit operator input widths disagree");
    if (["eq", "ult"].includes(value.op)) bits = 1;
  }
  return {
    kind: value.op,
    args,
    width: width(bits),
    ...(value.op === "slice" ? { high: value.high, low: value.low } : {}),
  };
}

export function evaluate(expr, ref) {
  if (expr.kind === "ref") return ref(expr.ref);
  if (expr.kind === "constant") return expr.bits;
  // A mux evaluates only its selected data path; structural dependencies still
  // include both paths and the selector.
  if (expr.kind === "mux")
    return evaluate(expr.args[evaluate(expr.args[0], ref) ? 1 : 2], ref);
  const a = evaluate(expr.args[0], ref),
    b = expr.args[1] && evaluate(expr.args[1], ref);
  const operations = {
    not: () => ~a,
    and: () => a & b,
    or: () => a | b,
    xor: () => a ^ b,
    add: () => a + b,
    sub: () => a - b,
    eq: () => BigInt(a === b),
    ult: () => BigInt(a < b),
    slice: () => a >> BigInt(expr.low),
    concat: () =>
      expr.args.reduce(
        (value, arg) => (value << BigInt(arg.width)) | evaluate(arg, ref),
        0n,
      ),
  };
  return operations[expr.kind]() & mask(expr.width);
}

export function verilog(expr, ref) {
  if (expr.kind === "ref") return ref(expr.ref);
  if (expr.kind === "constant")
    return `${expr.width}'h${expr.bits.toString(16)}`;
  const args = expr.args.map((arg) => verilog(arg, ref));
  if (expr.kind === "mux") return `(${args[0]} ? ${args[1]} : ${args[2]})`;
  if (expr.kind === "concat") return `{${args.join(", ")}}`;
  if (expr.kind === "slice")
    return `${expr.width}'((${args[0]}) >> ${expr.low})`;
  if (expr.kind === "not") return `(~${args[0]})`;
  const operators = {
    and: "&",
    or: "|",
    xor: "^",
    add: "+",
    sub: "-",
    eq: "==",
    ult: "<",
  };
  // Explicit size casts preserve modular arithmetic inside larger expressions.
  return `${expr.width}'((${args[0]}) ${operators[expr.kind]} (${args[1]}))`;
}
