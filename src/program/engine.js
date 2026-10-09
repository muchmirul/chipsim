import { normalizeParameters, validateInputs } from "../model/engine.js";
import { registerAccessInputs } from "../model/register-access.js";
import { literal, ProgramError } from "./parse.js";

const own = (object, key) => Object.hasOwn(object, key);

export class ProgramDebugger {
  constructor(
    model,
    program,
    { maxTicks = 10000, maxSteps = 10000, guides = [] } = {},
  ) {
    if (program.modelId !== model.id)
      throw new ProgramError(
        1,
        `Program selects ${program.modelId}, not ${model.id}.`,
      );
    if (
      !Number.isInteger(maxTicks) ||
      maxTicks < 1 ||
      maxTicks > 10000 ||
      !Number.isInteger(maxSteps) ||
      maxSteps < 1 ||
      maxSteps > 10000
    )
      throw new Error("Program limits must be 1–10000.");
    this.model = model;
    this.program = program;
    this.maxTicks = maxTicks;
    this.maxSteps = maxSteps;
    this.guides = guides;
    this.breakpoints = new Set();
    const supplied = {};
    for (const [name, token] of Object.entries(program.parameters)) {
      const definition = model.parameters.find((item) => item.id === name);
      if (!definition) throw new ProgramError(1, "Unknown parameter " + name);
      if (definition.type === "boolean" && !["true", "false"].includes(token))
        throw new ProgramError(
          1,
          "Boolean parameter " + name + " requires true or false.",
        );
      supplied[name] =
        definition.type === "integer"
          ? literal(token, 1)
          : definition.type === "boolean"
            ? { true: true, false: false }[token]
            : token;
    }
    this.parameters = normalizeParameters(model.parameters, supplied);
    this.reset();
    this.validate();
  }
  validate() {
    const knownVariables = new Set(
      this.program.instructions
        .filter((i) => ["read", "let"].includes(i.op))
        .map((i) => (i.op === "read" ? i.args[2] : i.args[0])),
    );
    if (knownVariables.size > 64)
      throw new ProgramError(1, "At most 64 local variables.");
    const target = (token, line) => {
      if (/^\$/.test(token) && knownVariables.has(token.slice(1))) return;
      const [kind, name, extra] = token.split(".");
      if (
        !extra &&
        ((kind === "signal" && this.model.signals.some((s) => s.id === name)) ||
          (kind === "reg" &&
            (this.model.registers?.some((r) => r.id === name) ||
              own(this.snapshot.registers, name))))
      )
        return;
      throw new ProgramError(line, "Unknown observed target " + token);
    };
    for (const { op, args, line } of this.program.instructions) {
      if (op === "drive") {
        try {
          validateInputs(this.model.signals, [
            { tick: 1, signal: args[0], value: literal(args[1], line) },
          ]);
        } catch (error) {
          throw new ProgramError(line, error.message);
        }
        if (Object.values(this.model.registerInterface || {}).includes(args[0]))
          throw new ProgramError(
            line,
            "Use read/write for register transaction fields.",
          );
      }
      if (op === "wait") {
        const count = literal(args[0], line);
        if (count < 1 || count > this.maxTicks)
          throw new ProgramError(
            line,
            "Wait must be 1–" + this.maxTicks + " ticks.",
          );
      }
      if (["read", "write"].includes(op)) {
        const entry = this.model.registerMap?.find((r) => r.name === args[0]);
        if (!this.model.registerInterface || !entry)
          throw new ProgramError(line, "Unknown addressed register " + args[0]);
        if (
          (op === "read" && entry.access === "wo") ||
          (op === "write" && entry.access === "ro")
        )
          throw new ProgramError(
            line,
            "Unsupported " + op + " access to " + args[0],
          );
        if (op === "write") {
          const value = literal(args[1], line),
            signal = this.model.signals.find(
              (s) => s.id === this.model.registerInterface.writeData,
            );
          if (value >= 2 ** signal.width)
            throw new ProgramError(line, "Write value exceeds the bus width.");
        }
      }
      if (op === "let") literal(args[1], line);
      if (["expect", "if"].includes(op)) {
        target(args[0], line);
        literal(args[2], line, { z: true });
      }
    }
  }
  reset() {
    this.pc = 0;
    this.tick = 0;
    this.inputs = [];
    this.variables = Object.create(null);
    this.steps = [];
    this.error = null;
    this.status = "paused";
    this.trace = this.model
      .simulate(this.parameters, { inputs: [], ticks: 1 })
      .slice(0, 1);
    if (this.trace[0]?.phase === "fault")
      throw new Error("Model faults during initialization.");
  }
  get next() {
    return this.program.instructions[this.pc];
  }
  get snapshot() {
    return this.trace[this.tick];
  }
  observe(token, line) {
    if (token.startsWith("$")) {
      const key = token.slice(1);
      if (!own(this.variables, key))
        throw new ProgramError(
          line,
          "Variable has not been initialized: " + key,
        );
      return this.variables[key];
    }
    const [kind, key] = token.split(".");
    const container =
      kind === "signal" ? this.snapshot.signals : this.snapshot.registers;
    if (!own(container, key))
      throw new ProgramError(line, "Value is unavailable: " + token);
    return container[key];
  }
  step() {
    if (["halted", "fault"].includes(this.status)) return null;
    const instruction = this.next;
    if (!instruction) {
      this.status = "halted";
      return null;
    }
    const { op, args, line } = instruction;
    if (this.steps.length >= this.maxSteps) {
      this.error = new ProgramError(line, "Execution step limit reached.");
      this.status = "fault";
      return null;
    }
    const before = this.tick;
    let tick = this.tick,
      inputs = this.inputs,
      pc = this.pc + 1,
      variable,
      value;
    try {
      if (op === "drive") {
        tick++;
        inputs = validateInputs(this.model.signals, [
          ...inputs,
          { tick, signal: args[0], value: literal(args[1], line) },
        ]);
      }
      if (op === "wait") tick += literal(args[0], line);
      if (["read", "write"].includes(op)) {
        tick++;
        const entry = this.model.registerMap.find((r) => r.name === args[0]);
        inputs = registerAccessInputs(this.model, inputs, {
          tick,
          operation: op,
          address: entry.address,
          value: op === "write" ? literal(args[1], line) : 0,
        });
      }
      if (tick > this.maxTicks)
        throw new ProgramError(line, "Simulation tick limit reached.");
      let trace = this.trace;
      if (tick > before) {
        trace = this.model
          .simulate(this.parameters, { inputs, ticks: tick })
          .slice(0, tick + 1);
        if (!trace[tick])
          throw new ProgramError(
            line,
            "Experiment reached the end of this model's trace.",
          );
        const fault = trace.slice(before + 1).find((s) => s.phase === "fault");
        if (fault)
          throw new ProgramError(
            line,
            `Model fault at tick ${fault.tick}: ${fault.detail || fault.message}`,
          );
        if (["read", "write"].includes(op)) {
          const bus = this.model.registerInterface,
            signals = trace[tick].signals;
          if (!signals[bus.valid] || signals[bus.error])
            throw new ProgramError(
              line,
              "Register transaction was rejected; inspect reset and bus conditions.",
            );
          if (op === "read") {
            variable = args[2];
            value = signals[bus.readData];
          }
        }
      }
      if (op === "let") {
        variable = args[0];
        value = literal(args[1], line);
      }
      if (["expect", "if"].includes(op)) {
        const observed = this.observe(args[0], line),
          expected = literal(args[2], line, { z: true });
        const matched =
          args[1] === "==" ? observed === expected : observed !== expected;
        if (op === "expect" && !matched)
          throw new ProgramError(
            line,
            `Assertion failed: ${args[0]} ${args[1]} ${args[2]}, observed ${observed}.`,
          );
        if (op === "if" && matched) pc = this.program.labels.get(args[4]);
      }
      if (op === "goto") pc = this.program.labels.get(args[0]);
      // Commit the entire statement only after simulation/access validation.
      this.inputs = inputs;
      this.trace = trace;
      this.tick = tick;
      this.pc = pc;
      if (variable !== undefined) this.variables[variable] = value;
      const event = {
        index: this.steps.length,
        line,
        text: instruction.text,
        beforeTick: before,
        tick,
        pc,
        variables: { ...this.variables },
        status: "executed",
      };
      this.steps.push(event);
      this.status = op === "halt" || !this.next ? "halted" : "paused";
      return event;
    } catch (error) {
      this.error =
        error instanceof ProgramError
          ? error
          : new ProgramError(line, error.message);
      this.status = "fault";
      this.steps.push({
        index: this.steps.length,
        line,
        text: instruction.text,
        beforeTick: before,
        tick: before,
        pc: this.pc,
        variables: { ...this.variables },
        status: "fault",
        error: this.error.message,
      });
      return this.steps.at(-1);
    }
  }
  continue() {
    const skip = this.status === "breakpoint" ? this.next?.line : null;
    let first = true;
    while (this.next && !["halted", "fault"].includes(this.status)) {
      if (
        this.breakpoints.has(this.next.line) &&
        !(first && skip === this.next.line)
      ) {
        this.status = "breakpoint";
        break;
      }
      first = false;
      this.step();
    }
    return this.report();
  }
  back() {
    const count = Math.max(0, this.steps.length - 1);
    this.reset();
    for (let i = 0; i < count; i++) this.step();
    return this.report();
  }
  toggleBreakpoint(line) {
    if (!this.program.instructions.some((i) => i.line === line))
      throw new Error("Breakpoints require an executable source line.");
    if (this.breakpoints.has(line)) this.breakpoints.delete(line);
    else this.breakpoints.add(line);
  }
  report({ includeSteps = true } = {}) {
    return {
      format: "chipsim-program-debug",
      version: 1,
      language: "experiment",
      ok: this.status !== "fault",
      modelId: this.model.id,
      status: this.status,
      tick: this.tick,
      nextLine: this.next?.line ?? null,
      parameters: this.parameters,
      variables: { ...this.variables },
      guides: this.guides,
      stepCount: this.steps.length,
      ...(includeSteps ? { steps: this.steps } : {}),
      diagnostics: this.error
        ? [
            {
              code: this.error.code,
              line: this.error.line,
              message: this.error.message,
            },
          ]
        : [],
    };
  }
}
