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
    "benchmark_prepare",
    "Capture a built-in or project-relative benchmark and return context, candidatePath, candidateHash, fixedHashes and a readable baseline candidateResource. Weighted workflows declare proofs in their target.",
    { benchmark: string(1024), formal: { type: "boolean" } },
    ["benchmark"],
    false,
  ],
  [
    "benchmark_start",
    "Evaluate one UTF-8 candidate up to 64 KiB using the captured context and its exact SHA-256. Save a stable requestId before submitting. Poll chipsim_job_status.",
    {
      context: id,
      candidateHash: id,
      content: string(65536),
      requestId: string(128),
    },
    ["context", "candidateHash", "content", "requestId"],
    false,
  ],
  [
    "benchmark_result",
    "Read the verified terminal report, including failed proof diagnostics. Only rank measured results. Use artifact for the outer report and evidence.benchmarkJob for native stage artifacts.",
    { job: uuid },
    ["job"],
    true,
  ],
  [
    "workflow_status",
    "Inspect persisted workflow state, release blockers and suggested explicit actions without starting jobs.",
    { run: id, ...paging },
    [],
    true,
  ],
  [
    "manufacturing_profiles",
    "Discover versioned manufacturing profiles, setup prerequisites, release checks and native delivery contents.",
    {},
    [],
    true,
  ],
  [
    "environment_setup",
    "Start an explicit pinned manufacturing environment setup job. Uses the ordinary job status, logs, cancellation and retry tools.",
    { profile: string(128), requestId: { ...string(128), minLength: 1 } },
    ["profile", "requestId"],
    false,
  ],
  [
    "project_bootstrap",
    "Create an editable digital manufacturing project without overwriting existing files. Requires a verified environment setup run.",
    {
      profile: string(128),
      environment: id,
      requestId: { ...string(128), minLength: 1 },
      metadata: {
        type: "object",
        properties: {
          id: string(128),
          title: string(128),
          top: string(128),
          author: string(256),
          description: string(4096),
          clockHz: integer(1000000000, 1),
          tiles: string(16),
          license: string(32768),
          pinout: {
            type: "object",
            properties: {
              ui: {
                type: "array",
                items: string(256),
                minItems: 8,
                maxItems: 8,
              },
              uo: {
                type: "array",
                items: string(256),
                minItems: 8,
                maxItems: 8,
              },
              uio: {
                type: "array",
                items: string(256),
                minItems: 8,
                maxItems: 8,
              },
            },
            required: ["ui", "uo", "uio"],
            additionalProperties: false,
          },
        },
        required: [
          "id",
          "title",
          "top",
          "author",
          "description",
          "clockHz",
          "tiles",
          "license",
          "pinout",
        ],
        additionalProperties: false,
      },
    },
    ["profile", "environment", "metadata"],
    false,
  ],
  [
    "release_status",
    "Evaluate profile minimum checks, source freshness, native submission contents and project-required proofs for a release run.",
    { run: id },
    [],
    true,
  ],
  [
    "release_package",
    "Start a managed job producing a validated manufacturer archive, checksums and companion evidence from an eligible release run.",
    { run: id, requestId: { ...string(128), minLength: 1 } },
    ["run", "requestId"],
    false,
  ],
  [
    "artifact_read",
    "Read a verified artifact as a bounded base64 byte chunk with whole-file SHA-256 and chunk SHA-256. Offsets count bytes.",
    { ...artifact, offset: integer(2 ** 31), limit: integer(65536, 1) },
    ["artifact"],
    true,
  ],
  [
    "resource_read",
    "Read installed ChipSim guides, schemas, starter files or bounded project resources by URI. Start with chipsim://guide/workbench. Read chipsim://guide/evolution for benchmark scoring. Uses the same allowlist as MCP resources/read.",
    { uri: { ...string(), minLength: 1 } },
    ["uri"],
    true,
  ],
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
    { label: string(128), requestId: string(128) },
    ["label"],
    false,
  ],
  [
    "evidence_import",
    "Upload a verified evidence ZIP in bounded resumable chunks. Query by omitting data, finalize with finish.",
    {
      requestId: { ...string(128), minLength: 1 },
      sha256: id,
      bytes: integer(2 ** 31, 1),
      offset: integer(2 ** 31),
      data: string(87384),
      finish: { type: "boolean" },
    },
    ["requestId", "sha256", "bytes"],
    false,
  ],
  [
    "environment_check",
    "Inspect target tools, observer capabilities and manufacturing cache without running setup or a job.",
    { target: string(128), profile: string(128) },
    [],
    true,
  ],
  [
    "candidate_list",
    "List durable candidate records or recover a creation request.",
    { ...paging, requestId: string(128) },
    [],
    true,
  ],
  [
    "candidate_diff",
    "Export paged changes from the candidate base revision.",
    paging,
    ["candidate"],
    true,
  ],
  [
    "candidate_apply",
    "Apply candidate changes to its parent at its captured base revision.",
    { expectedRevision: id, expectedCandidateRevision: id },
    ["candidate", "expectedRevision"],
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
    "Read durable job status by exactly one of job or requestId. An optional bounded wait leaves the job running when the wait ends.",
    { job: uuid, requestId: string(128), waitMs: integer(10000) },
    [],
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
    "Inspect current target readiness and, separately, requirement coverage under the selected run’s captured declarations and evidence policy. Waivers are not passing evidence.",
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
const benchmarkInspection = new Set([
  "artifact_read",
  "artifacts",
  "evidence",
  "hardware",
  "source",
  "snapshot",
  "trace",
  "differences",
]);
// The result envelope stays versioned independently from each tool payload.
const object = { type: "object" };
const text = { type: "string" },
  boolean = { type: "boolean" },
  count = { type: "integer" };
const array = (items = object) => ({ type: "array", items });
const payload = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
});
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const pageResult = {
  items: array({}),
  total: count,
  nextOffset: nullable(count),
};
const jobResult = payload(
  { id: uuid, state: text, ready: boolean, generation: count },
  ["id", "state"],
);
const planResult = payload({
  valid: boolean,
  plan: nullable(id),
  snapshot: id,
  target: text,
  policy: object,
  tasks: array(),
});
const checksResult = payload(
  {
    ready: boolean,
    run: id,
    comparison: object,
    required: array(),
    changes: array(),
    requirementResults: array(),
    requirementCoverage: payload({
      status: {
        enum: [
          "not-declared",
          "unverified",
          "partial",
          "covered",
          "unavailable",
        ],
      },
      declared: nullable(count),
      covered: array(text),
      unverified: array(text),
    }),
  },
  ["ready", "requirementCoverage"],
);
const results = {
  benchmark_prepare: payload({
    context: id,
    candidateHash: id,
    candidateResource: text,
    candidatePath: text,
    fixedHashes: object,
  }),
  benchmark_start: jobResult,
  benchmark_result: payload({
    jobState: text,
    measured: boolean,
    accepted: boolean,
    score: nullable({ type: "number" }),
    run: id,
    artifact: id,
    metrics: object,
    evidence: object,
    stages: object,
  }),
  workflow_status: payload({
    stage: text,
    prepared: boolean,
    nextActions: array(),
    jobs: array(),
  }),
  manufacturing_profiles: payload({ profiles: array() }),
  environment_setup: jobResult,
  environment_check: payload({
    adapters: array(text),
    observer: object,
    targets: array(),
  }),
  project_bootstrap: payload({
    profile: text,
    environment: id,
    targets: array(text),
    files: array(text),
  }),
  release_status: payload({
    ready: boolean,
    run: nullable(id),
    blockers: array(text),
    required: array(),
  }),
  release_package: jobResult,
  artifact_read: payload({
    artifact: id,
    sha256: id,
    chunkSha256: id,
    data: text,
    offset: count,
    bytes: count,
    length: count,
    nextOffset: nullable(count),
  }),
  evidence_import: payload({
    complete: boolean,
    sha256: id,
    bytes: count,
    nextOffset: count,
  }),
  resource_read: payload({ uri: text, mimeType: text, text }),
  project: payload({
    root: text,
    revision: id,
    capabilities: object,
    targets: object,
  }),
  file_list: payload(pageResult),
  file_search: payload(pageResult),
  file_read: payload({ path: text, text, sha256: id, resource: text }),
  file_write: payload({ path: text, sha256: id, bytes: count }),
  candidate_create: payload({ id: uuid, revision: id, baseRevision: id }),
  candidate_list: payload(pageResult),
  candidate_diff: payload({ ...pageResult, baseRevision: id, revision: id }),
  candidate_apply: payload({ revision: id, baseRevision: id }),
  revision: payload({ revision: id, fileCount: count }),
  validate: planResult,
  plan: planResult,
  job_start: jobResult,
  job_retry: jobResult,
  job_cancel: jobResult,
  job_status: payload({ state: text, id: uuid }, ["state"]),
  job_logs: payload({
    text,
    offset: count,
    cursor: count,
    nextOffset: nullable(count),
  }),
  artifacts: payload(pageResult),
  evidence: {
    anyOf: [
      payload({ record: object }),
      payload({ artifact: object, checks: array() }),
    ],
  },
  checks: checksResult,
  compare: payload({
    left: id,
    right: id,
    artifacts: array(),
    checks: array(),
  }),
  differences: payload({ ...pageResult, artifact: id }),
  export: payload({ id, bundle: text, records: count, objects: count }),
  hardware: payload({ ...pageResult, artifact: id }),
  trace: payload({ ...pageResult, artifact: id }),
  source: payload({ artifact: id, text, source: text }),
  snapshot: payload({ artifact: id, text, columns: count, rows: count }),
};
function outputContract(name) {
  if (!results[name]) throw Error("Missing result schema for " + name);
  return {
    ...resultSchema,
    properties: { ...resultSchema.properties, result: results[name] },
    anyOf: [
      {
        type: "object",
        properties: { ok: { const: true } },
        required: ["result", "ok"],
      },
      {
        type: "object",
        properties: { ok: { const: false } },
        required: ["error", "ok"],
      },
    ],
  };
}
export const workbenchTools = definitions.map(
  ([name, description, properties, required, readOnly]) => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        candidate: uuid,
        ...(benchmarkInspection.has(name) ? { benchmarkJob: uuid } : {}),
        ...properties,
      },
      required,
      additionalProperties: false,
    },
    outputSchema: outputContract(name),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: name === "file_write",
      idempotentHint:
        readOnly ||
        [
          "job_start",
          "environment_setup",
          "release_package",
          "benchmark_start",
          "benchmark_prepare",
        ].includes(name),
      openWorldHint: [
        "benchmark_start",
        "job_start",
        "plan",
        "job_retry",
        "environment_setup",
        "release_package",
      ].includes(name),
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
  } else if (type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      throw new Error(path + " must be a bounded array");
    value.forEach((item, i) =>
      validate(schema.items || {}, item, path + "[" + i + "]"),
    );
  } else if (type === "number" && !Number.isFinite(value))
    throw new Error(path + " must be a finite number");
  else if (type === "integer") {
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
