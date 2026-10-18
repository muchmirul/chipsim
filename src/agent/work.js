import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rmdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentError } from "./io.js";

export const workLimits = Object.freeze({
  sessions: 128,
  events: 2048,
  bytes: 16384,
  returnedEvents: 200,
  directoryEntries: 4096,
  metrics: 32,
});
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const eventName = /^([0-9]{6})\.json$/;
const kinds = [
  "plan",
  "edit",
  "tool",
  "candidate",
  "evaluation",
  "selection",
  "summary",
];
const statuses = [
  "running",
  "completed",
  "failed",
  "inconclusive",
  "cancelled",
  "passed",
];
const terminal = new Set(["completed", "failed", "cancelled"]);
const eventKeys = [
  "kind",
  "message",
  "status",
  "candidate",
  "parent",
  "generation",
  "stage",
  "metrics",
  "evidence",
];
const reporting = "agent-reported";

function invalid(message) {
  throw new AgentError("WORK_INVALID", message, [], 2);
}
function boundedText(value, label, maximum, empty = false) {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > maximum ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    invalid(`${label} must be ${empty ? "0" : "1"}–${maximum} text characters`);
  return value;
}
function object(value, label, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid(`${label} must be a JSON object`);
  if (keys && Object.keys(value).some((key) => !keys.includes(key)))
    invalid(`${label} contains unknown fields`);
}
function validUUID(value, label) {
  if (typeof value !== "string" || !uuid.test(value))
    invalid(`${label} must be a lowercase UUID`);
  return value;
}
function validTime(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid(`${label} must be an ISO timestamp`);
}
function byteLimit(value) {
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > workLimits.bytes)
    throw new AgentError("WORK_LIMIT", "Work record exceeds 16 KiB");
  return text;
}

async function directory(path, create = false) {
  if (create) {
    try {
      await mkdir(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new AgentError(
      "WORK_DIRECTORY",
      `Expected a directory, not a symlink: ${path}`,
    );
  return path;
}
async function location(project, create = false) {
  boundedText(project, "Project path", 4096);
  const path = await realpath(resolve(project));
  await directory(path);
  const agent = join(path, ".chipsim-agent");
  const work = join(agent, "work");
  try {
    await directory(agent, create);
    await directory(work, create);
  } catch (error) {
    if (!create && error.code === "ENOENT")
      return { project: path, work: null };
    throw error;
  }
  return { project: path, work };
}
async function entries(path) {
  const names = [];
  for await (const entry of await opendir(path)) {
    if (names.length === workLimits.directoryEntries)
      throw new AgentError(
        "WORK_LIMIT",
        `Work directory exceeds ${workLimits.directoryEntries} entries: ${path}`,
      );
    names.push(entry);
  }
  return names;
}

// Nonblocking, no-follow reads reject FIFOs/symlinks before reading. Fixed-size
// buffers also bound a file that grows after stat(). Imported JSON is only data.
export async function readWorkEvent(file) {
  boundedText(file, "Event file", 4096);
  const handle = await open(
    resolve(file),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > workLimits.bytes)
      throw new AgentError(
        "FILE_LIMIT",
        `Expected a regular file of at most ${workLimits.bytes} bytes: ${file}`,
      );
    const bytes = Buffer.alloc(workLimits.bytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > workLimits.bytes)
      throw new AgentError("FILE_LIMIT", "Work JSON exceeds 16 KiB");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      );
    } catch {
      throw new AgentError("INVALID_JSON", `Invalid JSON: ${file}`);
    }
  } finally {
    await handle.close();
  }
}

function validateEvent(project, event) {
  object(event, "Work event", eventKeys);
  if (!kinds.includes(event.kind))
    invalid(`Work event kind must be one of ${kinds.join(", ")}`);
  const result = {
    kind: event.kind,
    message: boundedText(event.message, "Event message", 4000),
  };
  if (event.status !== undefined) {
    if (!statuses.includes(event.status))
      invalid(`Event status must be one of ${statuses.join(", ")}`);
    result.status = event.status;
  }
  for (const key of ["candidate", "parent"]) {
    if (event[key] !== undefined) {
      if (typeof event[key] !== "string" || !identifier.test(event[key]))
        invalid(
          `${key} must be a 1–128 character identifier (letters, digits, '.', '_' or '-')`,
        );
      result[key] = event[key];
    }
  }
  if (event.kind === "candidate" && !event.candidate)
    invalid("Candidate events require a candidate identifier");
  if (
    (event.parent !== undefined || event.generation !== undefined) &&
    !event.candidate
  )
    invalid("Parent and generation require a candidate identifier");
  if (event.parent !== undefined && event.parent === event.candidate)
    invalid("A candidate cannot be its own parent");
  if (event.generation !== undefined) {
    if (!Number.isSafeInteger(event.generation) || event.generation < 0)
      invalid("Generation must be a nonnegative safe integer");
    result.generation = event.generation;
  }
  if (event.stage !== undefined)
    result.stage = boundedText(event.stage, "Stage", 128);
  if (event.metrics !== undefined) {
    object(event.metrics, "Metrics");
    if (Object.keys(event.metrics).length > workLimits.metrics)
      invalid("At most 32 metrics are allowed per event");
    result.metrics = Object.fromEntries(
      Object.entries(event.metrics).map(([name, metric]) => {
        boundedText(name, "Metric name", 64);
        object(metric, "Metric", ["value", "unit"]);
        if (typeof metric.value !== "number" || !Number.isFinite(metric.value))
          invalid("Metric value must be finite");
        return [
          name,
          {
            value: metric.value,
            unit: boundedText(metric.unit, "Metric unit", 64, true),
          },
        ];
      }),
    );
  }
  if (event.evidence !== undefined) {
    object(event.evidence, "Evidence", ["project", "job", "run", "artifact"]);
    if (
      !["job", "run", "artifact"].some((key) =>
        Object.hasOwn(event.evidence, key),
      )
    )
      invalid("Evidence requires a job, run or artifact reference");
    result.evidence = {};
    for (const [key, value] of Object.entries(event.evidence)) {
      if (key === "project")
        result.evidence.project = resolve(
          project,
          boundedText(value, "Evidence project", 4096),
        );
      else if (key === "job")
        result.evidence.job = validUUID(value, "Evidence job");
      else {
        if (typeof value !== "string" || !hash.test(value))
          invalid(`Evidence ${key} must be a lowercase SHA-256 hash`);
        result.evidence[key] = value;
      }
    }
  }
  byteLimit(result);
  return result;
}

async function publish(path, name, value) {
  const temporary = join(path, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, byteLimit(value), { flag: "wx", mode: 0o600 });
    // link() publishes complete bytes without ever overwriting another writer.
    await link(temporary, join(path, name));
  } finally {
    await rm(temporary, { force: true });
  }
}
function validateHeader(record, id) {
  object(record, "Work session", [
    "format",
    "version",
    "id",
    "goal",
    "mode",
    "createdAt",
    "reporting",
  ]);
  if (
    record.format !== "chipsim-agent-work" ||
    record.version !== 1 ||
    record.id !== id ||
    record.reporting !== reporting
  )
    invalid("Invalid work session header");
  validUUID(record.id, "Session");
  boundedText(record.goal, "Goal", 4000);
  if (!["task", "evolution"].includes(record.mode))
    invalid("Work mode must be task or evolution");
  validTime(record.createdAt, "Session createdAt");
  return record;
}
async function header(work, id) {
  validUUID(id, "Session");
  const path = await directory(join(work, id));
  return validateHeader(await readWorkEvent(join(path, "session.json")), id);
}
async function headers(work) {
  if (!work) return [];
  const sessions = (await entries(work)).filter((entry) =>
    uuid.test(entry.name),
  );
  if (sessions.length > workLimits.sessions)
    throw new AgentError("WORK_LIMIT", "Work journal exceeds 128 sessions");
  const result = [];
  for (const entry of sessions) {
    try {
      result.push(await header(work, entry.name));
    } catch (error) {
      // A concurrent start has a directory before its immutable header exists.
      if (error.code !== "ENOENT") throw error;
    }
  }
  return result.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

export async function startWork(project, { goal, mode = "task" } = {}) {
  boundedText(goal, "Goal", 4000);
  if (!["task", "evolution"].includes(mode))
    invalid("Work mode must be task or evolution");
  const record = {
    format: "chipsim-agent-work",
    version: 1,
    id: randomUUID(),
    goal,
    mode,
    createdAt: new Date().toISOString(),
    reporting,
  };
  byteLimit(record);
  const { work } = await location(project, true);
  const existing = (await entries(work)).filter((entry) =>
    uuid.test(entry.name),
  );
  if (existing.length >= workLimits.sessions)
    throw new AgentError(
      "WORK_LIMIT",
      "Work journal is full (128 sessions); choose another project directory",
    );
  const path = join(work, record.id);
  await mkdir(path);
  // Recheck after admission so simultaneous starts cannot exceed the bound.
  const admitted = (await entries(work)).filter((entry) =>
    uuid.test(entry.name),
  );
  if (admitted.length > workLimits.sessions) {
    await rmdir(path);
    throw new AgentError("WORK_LIMIT", "Work journal is full (128 sessions)");
  }
  await publish(path, "session.json", record);
  return record;
}

export async function appendWorkEvent(project, session, event) {
  validUUID(session, "Session");
  const place = await location(project);
  const value = validateEvent(place.project, event);
  if (!place.work)
    throw new AgentError(
      "WORK_SESSION",
      "No work sessions exist in this project",
    );
  await header(place.work, session);
  const path = join(place.work, session);
  const files = await entries(path);
  let sequence =
    Math.max(
      0,
      ...files
        .filter((file) => eventName.test(file.name))
        .map((file) => Number(file.name.slice(0, 6))),
    ) + 1;
  const id = randomUUID();
  while (sequence <= workLimits.events) {
    if (sequence > 1) {
      const previous = await readWorkEvent(
        join(path, `${String(sequence - 1).padStart(6, "0")}.json`),
      );
      if (previous.kind === "summary" && terminal.has(previous.status))
        throw new AgentError(
          "WORK_CLOSED",
          "This work session has a terminal summary; start a new session",
        );
    }
    const record = {
      ...value,
      format: "chipsim-agent-work-event",
      version: 1,
      id,
      sequence,
      time: new Date().toISOString(),
      reporting,
    };
    try {
      await publish(path, `${String(sequence).padStart(6, "0")}.json`, record);
      return record;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      sequence++;
    }
  }
  throw new AgentError(
    "WORK_LIMIT",
    "Work session is full (2048 events); start a new session. Existing events are preserved.",
  );
}

export async function listWork(project) {
  return headers((await location(project)).work);
}

export async function workStatus(project, { session, limit = 50 } = {}) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > workLimits.returnedEvents
  )
    invalid("Event limit must be an integer from 1 to 200");
  if (session !== undefined) validUUID(session, "Session");
  const place = await location(project);
  const empty = {
    project: place.project,
    session: null,
    events: [],
    candidates: [],
    totalEvents: 0,
    reporting,
  };
  if (!place.work) {
    if (session)
      throw new AgentError(
        "WORK_SESSION",
        "No work sessions exist in this project",
      );
    return empty;
  }
  const selected = session
    ? await header(place.work, session)
    : (await headers(place.work))[0];
  if (!selected) return empty;
  const path = join(place.work, selected.id);
  const files = (await entries(path))
    .filter((file) => eventName.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (files.length > workLimits.events)
    throw new AgentError("WORK_LIMIT", "Work session exceeds 2048 events");
  const events = [],
    candidates = new Map();
  let status = "running";
  for (const file of files) {
    const event = await readWorkEvent(join(path, file.name));
    object(event, "Stored work event", [
      ...eventKeys,
      "format",
      "version",
      "id",
      "sequence",
      "time",
      "reporting",
    ]);
    if (
      event.format !== "chipsim-agent-work-event" ||
      event.version !== 1 ||
      event.reporting !== reporting ||
      event.sequence !== Number(file.name.slice(0, 6)) ||
      event.sequence < 1 ||
      event.sequence > workLimits.events
    )
      invalid("Invalid stored work event");
    validUUID(event.id, "Event ID");
    validTime(event.time, "Event time");
    const value = validateEvent(
      place.project,
      Object.fromEntries(
        eventKeys
          .filter((key) => Object.hasOwn(event, key))
          .map((key) => [key, event[key]]),
      ),
    );
    const normalized = { ...event, ...value };
    events.push(normalized);
    if (event.kind === "summary" && terminal.has(event.status))
      status = event.status;
    if (event.candidate) {
      const candidate = candidates.get(event.candidate) || {
        id: event.candidate,
        status: "running",
        metrics: {},
        reporting,
      };
      if (value.kind === "candidate" && value.status === "running") {
        candidate.metrics = {};
        delete candidate.evidence;
      }
      for (const key of [
        "parent",
        "generation",
        "status",
        "stage",
        "message",
        "evidence",
      ])
        if (Object.hasOwn(value, key)) candidate[key] = value[key];
      if (value.metrics)
        candidate.metrics = { ...candidate.metrics, ...value.metrics };
      candidate.updatedAt = event.time;
      candidates.set(event.candidate, candidate);
    }
  }
  return {
    ...empty,
    session: { ...selected, status },
    events: events.slice(-limit),
    candidates: [...candidates.values()],
    totalEvents: events.length,
  };
}
