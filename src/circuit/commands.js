import { readJSON, jsonText } from "../agent/io.js";
import { circuitLimits } from "./model.js";
import {
  readCircuit,
  buildCircuit,
  readBundle,
  relationDescription,
} from "./files.js";
import { evaluateStep, checkCoverage, initialSnapshot } from "./relation.js";

export const circuitUsage = `Connected circuit model (authored binary hardware; no PDF)
  chipsim circuit inspect SOURCE.json
  chipsim circuit check SOURCE.json
  chipsim circuit step SOURCE.json --snapshot SNAPSHOT.json
  chipsim circuit build SOURCE.json --out NEW_DIRECTORY [--stimulus EVENTS.json]
  chipsim circuit run SOURCE.json --out NEW_DIRECTORY [--stimulus EVENTS.json]
  chipsim circuit verify SOURCE.json --out NEW_DIRECTORY [--cases CASES.json] [--rtl IMPLEMENTATION.sv]
  chipsim circuit validate BUNDLE/circuit.json
  chipsim circuit import SOURCE.sv --top TOP --clock CLK --initial INPUTS.json --out NEW_DIRECTORY [--yosys PATH] [--cases CASES.json]
TUI: chipsim --circuit SOURCE.json|BUNDLE/circuit.json
Single rising clock, explicit binary initialization, fixed port connections,
atomic updates, finite unsigned vectors and synchronous reset rules.
Coverage is exact symbolic rule completeness/agreement, not temporal proof.
Native verify compares every binary state/input combination up to 12 bits,
or explicit cases for larger domains. No provider/tool installation.
See docs/CONNECTED_CIRCUITS.md.`;

export async function circuitCommand(args, { signal } = {}) {
  const envelope = { format: "chipsim-circuit-result", version: 1 };
  try {
    if (!args.length || ["help", "--help", "-h"].includes(args[0]))
      return {
        result: {
          ...envelope,
          ok: true,
          help: circuitUsage,
          limits: circuitLimits,
        },
        exitCode: 0,
      };
    const [command, file, ...rest] = args;
    const allowed = {
      inspect: [],
      check: [],
      step: ["snapshot"],
      build: ["out", "stimulus"],
      run: ["out", "stimulus"],
      verify: ["out", "cases", "rtl"],
      validate: [],
      import: ["out", "top", "clock", "initial", "yosys", "cases"],
    };
    if (!Object.hasOwn(allowed, command) || !file || file.startsWith("--"))
      throw new Error(
        "Expected circuit command and source/bundle path. " + circuitUsage,
      );
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i].replace(/^--/, "");
      if (
        !rest[i].startsWith("--") ||
        !allowed[command].includes(key) ||
        Object.hasOwn(options, key) ||
        !rest[i + 1] ||
        rest[i + 1].startsWith("--")
      )
        throw new Error("Unknown/duplicate/missing option " + rest[i]);
      options[key] = rest[i + 1];
    }
    let result;
    if (command === "import") {
      if (!options.out) throw new Error("Choose --out NEW_DIRECTORY");
      result = await (
        await import("./import.js")
      ).importCircuit(file, options.out, { ...options, signal });
    } else if (command === "validate") {
      const bundle = await readBundle(file);
      result = {
        ok: true,
        sourceStatus: bundle.sourceStatus,
        sourceStatuses: bundle.sourceStatuses,
        evaluationStatus: bundle.report.status,
        storedOutcome: bundle.report.ok,
        source: bundle.report.source,
        compiler: bundle.report.compiler,
        coverage: bundle.coverage,
      };
    } else if (["build", "run", "verify"].includes(command)) {
      if (!options.out) throw new Error("Choose --out NEW_DIRECTORY");
      result = await buildCircuit(file, options.out, {
        ...options,
        operation: command,
        signal,
      });
    } else {
      const { model, source } = await readCircuit(file),
        coverage = checkCoverage(model);
      result = { ok: coverage.ok, source, coverage };
      if (command === "inspect")
        result = {
          ...result,
          relation: relationDescription(model),
          initial: initialSnapshot(model),
        };
      if (command === "step") {
        if (!options.snapshot)
          throw new Error(
            "Step requires --snapshot with explicit state, sampled inputs and previousClock",
          );
        result = {
          ...result,
          step: evaluateStep(model, await readJSON(options.snapshot, 1048576)),
        };
      }
    }
    return {
      result: { ...result, ...envelope, command },
      exitCode: result.ok ? 0 : 1,
    };
  } catch (error) {
    return {
      result: { ...envelope, ok: false, error: error.message },
      exitCode: error.exitCode ?? 2,
    };
  }
}
export async function main(args) {
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const { result, exitCode } = await circuitCommand(args, {
      signal: controller.signal,
    });
    process.stdout.write(jsonText(result));
    process.exitCode = controller.signal.aborted ? 130 : exitCode;
    return result;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
