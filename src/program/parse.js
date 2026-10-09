import { parsePayload } from "../core/values.js";

export class ProgramError extends Error {
  constructor(line, message) {
    super(`Line ${line}: ${message}`);
    this.code = "PROGRAM";
    this.line = line;
  }
}

const id = /^[a-zA-Z_][\w-]*$/;
function operands(raw, line) {
  const tokens = [];
  const token = /"(?:\\.|[^"\\])*"|[^\s"]+/y;
  let offset = 0;
  while (offset < raw.length) {
    while (/\s/.test(raw[offset] || "")) offset++;
    if (offset === raw.length) break;
    token.lastIndex = offset;
    const match = token.exec(raw);
    if (
      !match ||
      (token.lastIndex < raw.length && !/\s/.test(raw[token.lastIndex]))
    )
      throw new ProgramError(
        line,
        "Separate operands with spaces; use JSON double quotes for names containing spaces.",
      );
    try {
      tokens.push(match[0].startsWith('"') ? JSON.parse(match[0]) : match[0]);
    } catch {
      throw new ProgramError(line, "Invalid JSON-quoted operand.");
    }
    offset = token.lastIndex;
  }
  return tokens;
}
export function literal(text, line, { z = false } = {}) {
  if (z && text === "Z") return "Z";
  const value = parsePayload(text)?.value;
  if (!Number.isSafeInteger(value))
    throw new ProgramError(
      line,
      "Use decimal, 0x hexadecimal, 0b binary or 0o octal.",
    );
  return value;
}

// This is a bounded experiment language, not JavaScript or a vendor ISA.
export function parseProgram(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536)
    throw new ProgramError(1, "Program must be at most 64 KiB.");
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.length > 2000)
    throw new ProgramError(1, "At most 2000 source lines.");
  const instructions = [],
    labels = new Map(),
    parameters = {},
    guides = [];
  let modelId;
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1,
      raw = lines[index].trim();
    if (!raw || raw.startsWith("#")) continue;
    const guide = /^guide\s+(\S+)\s+(\S+)\s+(".*")$/.exec(raw);
    if (guide) {
      if (instructions.length)
        throw new ProgramError(
          line,
          "Put guide declarations before executable statements.",
        );
      let quote;
      try {
        quote = JSON.parse(guide[3]);
      } catch {
        throw new ProgramError(line, "Guide quote must be a JSON string.");
      }
      if (typeof quote !== "string" || quote.length < 8 || quote.length > 500)
        throw new ProgramError(
          line,
          "Guide quote must contain 8–500 characters.",
        );
      const page = literal(guide[2], line);
      if (page < 1 || page > 20000)
        throw new ProgramError(line, "PDF page must be 1–20000.");
      guides.push({ document: guide[1], page, quote, line });
      continue;
    }
    const parts = operands(raw, line),
      [op, ...args] = parts;
    const fail = (message) => {
      throw new ProgramError(line, message);
    };
    if (op === "model") {
      if (
        modelId ||
        instructions.length ||
        args.length !== 1 ||
        !id.test(args[0])
      )
        fail("Declare one model ID before executable statements.");
      modelId = args[0];
      continue;
    }
    if (op === "param") {
      if (
        instructions.length ||
        args.length !== 2 ||
        !id.test(args[0]) ||
        Object.hasOwn(parameters, args[0])
      )
        fail("Use param NAME VALUE once, before executable statements.");
      parameters[args[0]] = args[1];
      continue;
    }
    if (/^[a-zA-Z_][\w-]*:$/.test(op) && !args.length) {
      const name = op.slice(0, -1);
      if (labels.has(name)) fail("Duplicate label " + name);
      labels.set(name, instructions.length);
      continue;
    }
    const arity = {
      drive: 2,
      wait: 1,
      write: 2,
      read: 3,
      let: 2,
      expect: 3,
      goto: 1,
      if: 5,
      halt: 0,
    }[op];
    if (arity === undefined || args.length !== arity)
      fail("Unknown statement or wrong operands: " + op);
    if (op === "read" && (args[1] !== "into" || !id.test(args[2])))
      fail("Use read REGISTER into VARIABLE.");
    if (op === "let" && !id.test(args[0])) fail("Invalid variable name.");
    if (["expect", "if"].includes(op) && !["==", "!="].includes(args[1]))
      fail("Use == or !=.");
    if (op === "if" && args[3] !== "goto")
      fail("Use if TARGET == VALUE goto LABEL.");
    instructions.push({ op, args, line, text: raw });
  }
  if (!modelId || !instructions.length)
    throw new ProgramError(
      1,
      "A model declaration and executable statements are required.",
    );
  for (const instruction of instructions) {
    const label =
      instruction.op === "goto"
        ? instruction.args[0]
        : instruction.op === "if"
          ? instruction.args[4]
          : null;
    if (label !== null && !labels.has(label))
      throw new ProgramError(instruction.line, "Unknown label " + label);
  }
  return {
    format: "chipsim-program",
    version: 1,
    language: "experiment",
    text,
    lines,
    modelId,
    parameters,
    guides,
    instructions,
    labels,
  };
}
