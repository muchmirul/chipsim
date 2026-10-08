import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { AgentError, readJSON } from "./io.js";

export const activityLimit = 500;
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const activityDirectory = (project) =>
  resolve(project, ".chipsim-agent/activity");

// One atomically published file per event avoids interleaved JSON from agents
// running commands concurrently. Logging never shares the CLI's stdout.
export async function recordActivity(project, event) {
  const manifest = await readJSON(
    resolve(project, "chipsim.project.json"),
    65536,
  );
  if (manifest.format !== "chipsim-agent-project" || manifest.version !== 1)
    throw new AgentError(
      "PROJECT",
      "Activity requires a prepared ChipSim project",
    );
  const directory = activityDirectory(project);
  await mkdir(directory, { recursive: true });
  const time = new Date().toISOString();
  const id = `${Date.now()}-${randomUUID()}`;
  const record = {
    ...event,
    format: "chipsim-agent-activity",
    version: 1,
    id,
    time,
  };
  const text = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(text) > 16384)
    throw new AgentError("ACTIVITY_LIMIT", "Activity event exceeds 16 KiB");
  const temporary = join(directory, id + ".tmp");
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, join(directory, id + ".json"));
  } finally {
    await rm(temporary, { force: true });
  }
  if (
    record.command === "run" &&
    record.status === "succeeded" &&
    record.details?.resultSha256 &&
    record.details?.sessionSha256
  ) {
    const pointer = resolve(directory, "../latest-run.json");
    const temporaryPointer = pointer + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporaryPointer, text, { flag: "wx" });
      await rename(temporaryPointer, pointer);
    } finally {
      await rm(temporaryPointer, { force: true });
    }
  }
  const files = (await readdir(directory)).filter(validName).sort();
  await Promise.all(
    files
      .slice(0, -activityLimit)
      .map((file) => rm(join(directory, file), { force: true })),
  );
  return record;
}

const validName = (name) => /^\d{13}-[a-f0-9-]{36}\.json$/.test(name);
export async function readPublishedRun(project) {
  try {
    const event = await readJSON(
      resolve(project, ".chipsim-agent/latest-run.json"),
      16384,
    );
    if (
      event.format !== "chipsim-agent-activity" ||
      event.version !== 1 ||
      event.command !== "run" ||
      event.status !== "succeeded" ||
      typeof event.id !== "string" ||
      typeof event.time !== "string"
    )
      throw new AgentError("ACTIVITY", "Invalid completed-run pointer");
    return event;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function readActivity(project) {
  const directory = activityDirectory(project);
  let files;
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const events = [];
  for (const file of files.filter(validName).sort().slice(-activityLimit)) {
    try {
      const event = await readJSON(join(directory, file), 16384);
      if (
        event.format === "chipsim-agent-activity" &&
        event.version === 1 &&
        event.id + ".json" === file &&
        typeof event.time === "string" &&
        typeof event.command === "string" &&
        typeof event.status === "string" &&
        typeof event.message === "string"
      )
        events.push(event);
    } catch {
      /* A removed or malformed record must not break monitoring. */
    }
  }
  // Stable ordering also puts the completion after start for same-ms commands.
  return events.sort(
    (a, b) =>
      a.time.localeCompare(b.time) ||
      String(a.requestId).localeCompare(String(b.requestId)) ||
      (a.sequence || 0) - (b.sequence || 0) ||
      a.id.localeCompare(b.id),
  );
}
