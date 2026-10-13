// Shared by CLI validation and machine-readable discovery. This is the
// workbench contract; the older agent/hdl families keep their own help.
export const optionTypes = {
  project: { type: "string" },
  target: { type: "string" },
  out: { type: "string" },
  run: { type: "string" },
  path: { type: "string" },
  offset: { type: "integer", minimum: 0, maximum: 2 ** 31 },
  limit: { type: "integer", minimum: 1, maximum: 65536 },
  "timeout-ms": {
    type: "integer",
    minimum: 1,
    maximum: 60000,
    requires: "wait",
  },
  wait: { type: "boolean" },
  "no-reuse": { type: "boolean" },
};
const entry = (
  family,
  command,
  positionals,
  options,
  effect,
  description,
  required = ["project"],
) => ({
  family,
  command,
  positionals: positionals.map((name) => ({
    name: name.replace("?", ""),
    required: !name.endsWith("?"),
  })),
  options: Object.fromEntries(
    options.map((name) => [
      name,
      { ...optionTypes[name], required: required.includes(name) },
    ]),
  ),
  effect,
  description,
});
export const designCommands = [
  entry(
    "design",
    "guide",
    ["topic?"],
    [],
    "inspect",
    "Optional input/preparation recipes and installed starter files; no project, writes or tool execution. Topics are listed by design guide.",
    [],
  ),
  entry(
    "design",
    "commands",
    [],
    [],
    "inspect",
    "Discover workbench commands and integration formats without a project.",
    [],
  ),
  entry(
    "design",
    "init",
    ["directory"],
    [],
    "write",
    "Create new design and lock manifests without overwriting files.",
    [],
  ),
  entry(
    "design",
    "status",
    [],
    ["project", "target"],
    "inspect",
    "Current target, latest evidence, required checks, available tools and suggested argument arrays; never probes or executes tools.",
  ),
  entry(
    "design",
    "doctor",
    [],
    ["project", "target"],
    "probe",
    "Probe installed tool versions and resolve declared inputs.",
  ),
  entry(
    "design",
    "lock",
    [],
    ["project", "path"],
    "inspect",
    "Calculate an external directory fingerprint; does not edit the lock.",
    ["project", "path"],
  ),
  entry(
    "design",
    "plan",
    [],
    ["project", "target"],
    "snapshot",
    "Probe tools and capture a target input snapshot and execution plan.",
  ),
  entry(
    "design",
    "run",
    [],
    ["project", "target", "no-reuse", "wait", "timeout-ms"],
    "execute",
    "Accept a durable job; optionally wait. A wait timeout leaves the job running.",
  ),
  entry(
    "job",
    "status",
    ["id?"],
    ["project", "wait", "timeout-ms"],
    "inspect",
    "Inspect one job or list jobs. Wait requires an ID; dead workers are recovered.",
  ),
  entry(
    "job",
    "logs",
    ["id"],
    ["project", "offset", "limit"],
    "inspect",
    "Read a page of log bytes. Save cursor for the next poll, including at current EOF.",
  ),
  entry(
    "job",
    "cancel",
    ["id"],
    ["project"],
    "cancel",
    "Explicitly request job cancellation and preserve partial evidence.",
  ),
  entry(
    "job",
    "retry",
    ["id"],
    ["project", "wait", "timeout-ms"],
    "execute",
    "Retry a finished job using its original snapshot and a new attempt.",
  ),
  entry(
    "artifact",
    "list",
    [],
    ["project", "offset", "limit"],
    "inspect",
    "List artifact summaries in pages (maximum 200 entries).",
  ),
  entry(
    "artifact",
    "inspect",
    ["id"],
    ["project", "offset", "limit"],
    "inspect",
    "Verify an artifact and inspect lineage, checks and a bounded preview.",
  ),
  entry(
    "artifact",
    "verify",
    ["id"],
    ["project"],
    "inspect",
    "Verify an evidence record and its complete referenced closure.",
  ),
  entry(
    "artifact",
    "import",
    ["directory"],
    ["project"],
    "write",
    "Import a bundle or historical directory without executing it.",
  ),
  entry(
    "artifact",
    "export",
    ["id"],
    ["project", "out"],
    "write",
    "Export verified evidence to a new directory.",
    ["project", "out"],
  ),
  entry(
    "artifact",
    "compare",
    ["leftRun", "rightRun"],
    ["project"],
    "inspect",
    "Compare artifact bytes and recorded contexts from two runs.",
  ),
  entry(
    "checks",
    "",
    [],
    ["project", "target", "run"],
    "inspect",
    "Evaluate current required checks; exits unsuccessfully when readiness is blocked.",
  ),
];

export function parseCommand(args) {
  const [family, ...rest] = args,
    options = {},
    positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2),
      spec = optionTypes[key];
    if (!spec || Object.hasOwn(options, key))
      throw new Error("Unknown or duplicate option " + arg);
    if (spec.type === "boolean") options[key] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith("--"))
        throw new Error("Incomplete option " + arg);
      options[key] = spec.type === "integer" ? Number(value) : value;
      if (
        spec.type === "integer" &&
        (!Number.isSafeInteger(options[key]) ||
          options[key] < spec.minimum ||
          options[key] > spec.maximum)
      )
        throw new Error("Invalid " + arg);
    }
  }
  const command = family === "checks" ? "" : positional.shift();
  const spec = designCommands.find(
    (c) => c.family === family && c.command === command,
  );
  if (!spec) throw new Error("Unknown design command");
  if (
    positional.length > spec.positionals.length ||
    positional.length < spec.positionals.filter((p) => p.required).length
  )
    throw new Error(
      "Invalid positional arguments for " + family + " " + command,
    );
  for (const key of Object.keys(options)) {
    if (!spec.options[key]) throw new Error("Unexpected --" + key);
    const requires = spec.options[key].requires;
    if (requires && !options[requires])
      throw new Error("--" + key + " requires --" + requires);
  }
  for (const [key, value] of Object.entries(spec.options))
    if (value.required && options[key] === undefined)
      throw new Error("Missing --" + key);
  if (
    family === "job" &&
    command === "status" &&
    !positional.length &&
    options.wait
  )
    throw new Error("Waiting requires a job ID");
  return { family, command, options, positional };
}
