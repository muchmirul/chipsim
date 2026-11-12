const string = (maxLength = 4096) => ({ type: "string", maxLength });
const integer = (maximum, minimum = 0) => ({
  type: "integer",
  minimum,
  maximum,
});
const enumOf = (...values) => ({ type: "string", enum: values });
const id = { type: "string", pattern: "^[a-f0-9]{64}$" };
const uuid = { type: "string", pattern: "^[a-f0-9-]{36}$" };
const paging = { offset: integer(1000000), limit: integer(200, 1) };
const textPaging = { offset: integer(100000000), limit: integer(32768, 1) };
const artifact = { artifact: id };
export const resultSchema = {
  type: "object",
  properties: {
    format: { const: "chipsim-workbench-result" },
    version: { const: 1 },
    ok: { type: "boolean" },
    result: { type: "object" },
    error: {
      type: "object",
      properties: { code: string(), message: string(), details: {} },
      required: ["code", "message"],
      additionalProperties: false,
    },
  },
  required: ["format", "version", "ok"],
  additionalProperties: false,
};
const definitions = [
  [
    "project",
    "Discover project identity, targets, capabilities and source revision. Works before a project manifest exists.",
    {},
    [],
    true,
  ],
  [
    "file_list",
    "List bounded project-relative paths; internal stores and dependencies are excluded.",
    { ...paging, query: string(512) },
    [],
    true,
  ],
  [
    "file_read",
    "Read UTF-8 text and SHA-256. Offsets count Unicode code points; expectedHash protects edits.",
    { path: string(), ...textPaging },
    ["path"],
    true,
  ],
  [
    "file_search",
    "Literal search in project text; returns paths, line numbers, hashes and explicit skipped binary/large files.",
    { query: { ...string(512), minLength: 1 }, ...paging },
    ["query"],
    true,
  ],
  [
    "file_write",
    "Atomically create or replace one UTF-8 project file. expectedHash=null creates only; existing files require their full SHA-256. Invalid drafts remain editable.",
    {
      path: string(),
      text: string(1048576),
      expectedHash: { anyOf: [id, { type: "null" }] },
    },
    ["path", "text", "expectedHash"],
    false,
  ],
  [
    "candidate_create",
    "Copy project sources into an isolated candidate with a captured base revision. Pass its candidate ID to subsequent tools.",
    { label: string(128) },
    ["label"],
    false,
  ],
  [
    "revision",
    "Capture a content-addressed revision of all project files, independently of whether drafts validate.",
    {},
    [],
    false,
  ],
  [
    "validate",
    "Validate a target and source prerequisites without executing tools or publishing a run.",
    { target: string(128) },
    ["target"],
    true,
  ],
  [
    "plan",
    "Capture target inputs, lock identities and probe tool versions; returns an immutable execution plan.",
    { target: string(128) },
    ["target"],
    false,
  ],
  [
    "job_start",
    "Start a durable managed target. Reusing requestId returns the same accepted job, including after reconnect. Job acceptance is not simulation/check success.",
    {
      target: string(128),
      requestId: { ...string(128), minLength: 1 },
      reuse: { type: "boolean" },
    },
    ["target", "requestId"],
    false,
  ],
  [
    "job_status",
    "Read durable job status; optional bounded wait stops without cancelling the job.",
    { job: uuid, waitMs: integer(10000) },
    ["job"],
    true,
  ],
  [
    "job_logs",
    "Read incremental job logs using a byte cursor.",
    { job: uuid, ...textPaging },
    ["job"],
    true,
  ],
  [
    "job_cancel",
    "Explicitly cancel a managed job and its owned tool processes.",
    { job: uuid },
    ["job"],
    false,
  ],
  [
    "job_retry",
    "Retry a finished/interrupted job using its original captured inputs.",
    { job: uuid },
    ["job"],
    false,
  ],
  [
    "artifacts",
    "List published artifacts with IDs, kinds, sizes and resource links.",
    { ...paging, run: id },
    [],
    true,
  ],
  [
    "evidence",
    "Verify evidence closure and inspect bounded text/report content. Check records preserve verdict and scope.",
    { id, ...textPaging },
    ["id"],
    true,
  ],
  [
    "checks",
    "Inspect current target readiness, including stale/failed/missing/inconclusive checks.",
    { target: string(128), run: id },
    ["target"],
    true,
  ],
  [
    "compare",
    "Compare verified runs, contexts, checks and measured metrics. Numeric deltas require explicit nonempty matching contexts, scopes and units; missing context stays noncomparable. No invented aggregate score.",
    { left: id, right: id, leftCandidate: uuid, rightCandidate: uuid },
    ["left", "right"],
    true,
  ],
  [
    "differences",
    "Read mapped trace differences with original mapping, stimulus, time coverage and explicit truncation; not whole-design equivalence.",
    { ...artifact, ...paging },
    ["artifact"],
    true,
  ],
  [
    "export",
    "Export a verified run/evidence closure to a new project-relative directory for reproduction.",
    { id, destination: string() },
    ["id", "destination"],
    false,
  ],
  [
    "hardware",
    "Query real RTL or netlist objects, hierarchy, buses and connections with stable artifact-local IDs. Static connectivity is not observed execution.",
    {
      ...artifact,
      ...paging,
      object: string(),
      query: string(512),
      relation: enumOf("objects", "connections", "fanin", "fanout"),
    },
    ["artifact"],
    true,
  ],
  [
    "trace",
    "Query recorded events/assertions and exact values at an event. Preserves unknown/high impedance, scheduler order and capture limits.",
    {
      ...artifact,
      ...paging,
      at: integer(100000),
      object: string(),
      kind: enumOf(
        "initialize",
        "process",
        "signal",
        "boundary",
        "assertion",
        "finish",
        "diagnostic",
      ),
    },
    ["artifact"],
    true,
  ],
  [
    "source",
    "Read immutable captured source and current-file freshness. Managed HDL currentPath uses its captured manifest directory/input inventory; missing or unmapped sources stay unknown. Does not replace the recording.",
    { ...artifact, source: string(), ...textPaging },
    ["artifact", "source"],
    true,
  ],
  [
    "snapshot",
    "Render the shared terminal inspection for verified evidence and return a local inspection command.",
    {
      ...artifact,
      object: string(),
      at: integer(100000),
      columns: integer(240, 40),
      rows: integer(80, 12),
      view: enumOf("schematic", "debug", "wave", "program", "inspect"),
    },
    ["artifact"],
    true,
  ],
];
export const workbenchTools = definitions.map(
  ([name, description, properties, required, readOnly]) => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { candidate: uuid, ...properties },
      required,
      additionalProperties: false,
    },
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: name === "file_write",
      idempotentHint: readOnly || name === "job_start",
      openWorldHint: ["job_start", "plan", "job_retry"].includes(name),
    },
  }),
);

// The transport and local services enforce the same bounded JSON contract.
export function validate(schema, value, path = "arguments") {
  if (schema.anyOf) {
    if (
      !schema.anyOf.some((s) => {
        try {
          validate(s, value, path);
          return true;
        } catch {
          return false;
        }
      })
    )
      throw new Error(path + " does not match an allowed type");
    return;
  }
  if (schema.const !== undefined && value !== schema.const)
    throw new Error(path + " has an invalid constant");
  if (schema.enum && !schema.enum.includes(value))
    throw new Error(path + " has an unsupported value");
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(path + " must be an object");
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key))
        throw new Error(path + "." + key + " is required");
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) {
        if (schema.additionalProperties === false)
          throw new Error(path + "." + key + " is unknown");
      } else validate(schema.properties[key], value[key], path + "." + key);
    }
  } else if (type === "integer") {
    if (
      !Number.isSafeInteger(value) ||
      value < schema.minimum ||
      value > schema.maximum
    )
      throw new Error(path + " is outside its integer bounds");
  } else if (type === "string") {
    if (
      typeof value !== "string" ||
      value.length > (schema.maxLength ?? Infinity) ||
      value.length < (schema.minLength || 0) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    )
      throw new Error(path + " is not a valid bounded string");
  } else if (type === "boolean" && typeof value !== "boolean")
    throw new Error(path + " must be boolean");
  else if (type === "null" && value !== null)
    throw new Error(path + " must be null");
}
