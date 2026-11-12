import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { json, localPath, identity } from "./store.js";

// An explicit finite control-image contract, not an HDL compiler or scheduler.
// Cycle positions, instruction durations and resource costs are project inputs.
export function compileImage(contract, program) {
  const diagnostics = [],
    words = [],
    reservations = new Map();
  const invalid = (code, message, instruction) => {
    if (diagnostics.length < 256)
      diagnostics.push({
        code,
        message,
        ...(instruction === undefined ? {} : { instruction }),
      });
    else if (diagnostics.length === 256)
      diagnostics.push({
        code: "DIAGNOSTIC_LIMIT",
        message: "Additional failures omitted after 256 diagnostics",
      });
  };
  const integer = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
  if (
    contract?.format !== "chipsim-program-contract" ||
    contract.version !== 1 ||
    !integer(contract.wordWidth, 1, 32) ||
    !integer(contract.depth, 1, 65536) ||
    !contract.instructions ||
    !contract.resources
  ) {
    invalid(
      "INVALID_CONTRACT",
      "Expected bounded wordWidth, depth, instruction definitions and finite resources",
    );
    return { ok: false, diagnostics };
  }
  for (const [name, capacity] of Object.entries(contract.resources))
    if (!integer(capacity, 1, 65536))
      invalid("INVALID_RESOURCE", "Invalid resource capacity: " + name);
  const ranges = [];
  for (const [name, instruction] of Object.entries(contract.instructions)) {
    if (!instruction || typeof instruction !== "object") {
      invalid(
        "INVALID_INSTRUCTION",
        "Expected instruction definition: " + name,
      );
      continue;
    }
    if (
      !integer(instruction.operandBits, 0, contract.wordWidth - 1) ||
      !integer(
        instruction.opcode,
        0,
        2 ** (contract.wordWidth - instruction.operandBits) - 1,
      ) ||
      !integer(instruction.cycles, 1, 65536) ||
      !instruction.resources
    )
      invalid(
        "INVALID_INSTRUCTION",
        "Invalid encoding, duration or resources: " + name,
      );
    else {
      const start = instruction.opcode * 2 ** instruction.operandBits,
        end = start + 2 ** instruction.operandBits - 1;
      if (ranges.some(([lo, hi]) => start <= hi && end >= lo))
        invalid(
          "AMBIGUOUS_ENCODING",
          "Instruction encoding overlaps another instruction: " + name,
        );
      ranges.push([start, end]);
    }
    for (const [resource, count] of Object.entries(instruction.resources || {}))
      if (
        !Object.hasOwn(contract.resources, resource) ||
        !integer(count, 1, 65536)
      )
        invalid(
          "INVALID_RESOURCE",
          "Unknown or invalid resource cost: " + resource,
        );
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  if (
    program?.format !== "chipsim-program" ||
    program.version !== 1 ||
    !Array.isArray(program.instructions) ||
    !program.instructions.length ||
    program.instructions.length > contract.depth
  ) {
    invalid(
      "IMAGE_CAPACITY",
      "Expected a nonempty program no larger than the declared memory depth",
    );
    return { ok: false, diagnostics };
  }
  let reservationCount = 0;
  for (let i = 0; i < program.instructions.length; i++) {
    const entry = program.instructions[i],
      spec =
        entry &&
        Object.hasOwn(contract.instructions, entry.op) &&
        contract.instructions[entry.op];
    if (!spec) {
      invalid(
        "UNSUPPORTED_OPCODE",
        "Instruction is not declared by the hardware contract",
        i,
      );
      continue;
    }
    if (entry.cycle !== i)
      invalid(
        "UNSUPPORTED_SCHEDULE",
        "Each image word must declare its exact consecutive issue cycle; no implicit stalls or reordering",
        i,
      );
    if (!integer(entry.value, 0, 2 ** spec.operandBits - 1)) {
      invalid("OPERAND_RANGE", "Operand does not fit its declared bits", i);
      continue;
    }
    words.push(
      Number(
        BigInt(spec.opcode) * (1n << BigInt(spec.operandBits)) +
          BigInt(entry.value),
      ),
    );
    for (const [resource, cost] of Object.entries(spec.resources)) {
      for (let cycle = i; cycle < i + spec.cycles; cycle++) {
        if (++reservationCount > 1000000) {
          invalid(
            "VALIDATION_LIMIT",
            "Resource schedule exceeds one million reservations",
            i,
          );
          return { ok: false, diagnostics };
        }
        const key = resource + ":" + cycle,
          used = (reservations.get(key) || 0) + cost;
        reservations.set(key, used);
        if (used > contract.resources[resource])
          invalid(
            "RESOURCE_CONFLICT",
            `${resource} exceeds capacity at cycle ${cycle}`,
            i,
          );
      }
    }
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    wordWidth: contract.wordWidth,
    words,
    contract: identity(contract),
    program: identity(program),
    scope:
      "Declared encoding, issue schedule and finite resource constraints; does not prove hardware implementation or protocol correctness",
  };
}
export async function buildImage(options, workspace) {
  const contract = await json(join(workspace, localPath(options.contract))),
    program = await json(join(workspace, localPath(options.program)));
  const report = compileImage(contract, program);
  await mkdir(join(workspace, "out"), { recursive: true });
  await writeFile(
    join(workspace, "out/program-validation.json"),
    JSON.stringify(report, null, 2),
  );
  if (report.ok)
    await writeFile(
      join(workspace, "out/program.hex"),
      report.words
        .map((word) =>
          word.toString(16).padStart(Math.ceil(report.wordWidth / 4), "0"),
        )
        .join("\n") + "\n",
    );
  return { ok: report.ok, code: report.ok ? 0 : 1, nativeResult: report };
}
