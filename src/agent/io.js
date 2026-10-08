import { open, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parsePayload } from "../core/values.js";

export class AgentError extends Error {
  constructor(code, message, details = [], exitCode = 1) {
    super(message);
    Object.assign(this, { code, details, exitCode });
  }
}

export async function readBounded(file, limit) {
  const handle = await open(resolve(file), "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit)
      throw new AgentError(
        "FILE_LIMIT",
        `Expected a regular file of at most ${limit} bytes: ${file}`,
      );
    const bytes = await handle.readFile();
    if (bytes.length > limit)
      throw new AgentError(
        "FILE_LIMIT",
        `File exceeds ${limit} bytes: ${file}`,
      );
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readJSON(file, limit = 3 * 1048576) {
  const bytes = await readBounded(file, limit);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AgentError("INVALID_JSON", `Invalid JSON: ${file}`);
  }
}

export const jsonText = (value) => JSON.stringify(value, null, 2) + "\n";
export const writeJSON = (file, value) =>
  writeFile(file, jsonText(value), { flag: "wx" });

// Own only a newly created directory. Existing experiments are never replaced,
// including an empty directory, a symlink, or a concurrent writer's destination.
export async function createDirectory(destination, build) {
  const path = resolve(destination);
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new AgentError(
        "OUTPUT_EXISTS",
        `Choose a new output directory; already exists: ${path}`,
      );
    throw error;
  }
  try {
    return await build(path);
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

export function integer(value, label, min, max) {
  const number = parsePayload(value)?.value;
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new AgentError(
      "ARGUMENT",
      `${label} must be an integer from ${min} to ${max}`,
      [],
      2,
    );
  return number;
}
