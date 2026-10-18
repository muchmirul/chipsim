import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  writeFile,
  rename,
  link,
  unlink,
  lstat,
  readdir,
  copyFile,
  chmod,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";

export const VERSION = 1;
export const limits = {
  file: 2 ** 31,
  files: 20000,
  json: 16 * 1048576,
  log: 16 * 1048576,
};
export const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort(value[key])]),
    );
  return value;
}
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const identity = (value) => hash(canonical(value));
export function localPath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 4096 ||
    isAbsolute(path) ||
    /[\x00-\x1f\\]/.test(path) ||
    path.split("/").some((s) => !s || s === "." || s === "..")
  )
    throw new Error("Expected a relative path without traversal: " + path);
  return path;
}
export function recordId(id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid evidence ID: " + id);
  return id;
}
export async function json(file, max = limits.json) {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max)
      throw new Error("JSON file exceeds limit: " + file);
    const bytes = await handle.readFile();
    if (bytes.length > max) throw new Error("JSON file exceeds limit: " + file);
    return JSON.parse(bytes);
  } finally {
    await handle.close();
  }
}
export async function atomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  const handle = await open(tmp, "wx");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}
export async function files(root, entries = ["."]) {
  const found = [];
  async function visit(path) {
    const full = resolve(root, path),
      rel = relative(root, full);
    if (rel.startsWith("../") || isAbsolute(rel))
      throw new Error("File escapes input root");
    let ancestor = resolve(root);
    for (const part of rel.split("/").slice(0, -1)) {
      ancestor = join(ancestor, part);
      if ((await lstat(ancestor)).isSymbolicLink())
        throw new Error(
          "Evidence paths cannot traverse symbolic links: " + path,
        );
    }
    const stat = await lstat(full);
    if (stat.isSymbolicLink())
      throw new Error("Evidence inputs/outputs cannot be symlinks: " + path);
    if (stat.isDirectory()) {
      for (const name of (await readdir(full)).sort()) {
        if (
          [".git", ".chipsim", ".chipsim-agent", "node_modules"].includes(name)
        )
          continue;
        await visit(join(path, name));
      }
    } else if (stat.isFile()) {
      if (stat.size > limits.file)
        throw new Error("File exceeds 2 GiB: " + path);
      found.push(rel);
      if (found.length > limits.files)
        throw new Error("Evidence file count exceeds limit");
    } else throw new Error("Evidence must contain regular files: " + path);
  }
  for (const path of entries) await visit(path);
  return [...new Set(found)];
}
export async function fileDigest(file) {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > limits.file) throw new Error("File exceeds 2 GiB: " + file);
    digest.update(chunk);
  }
  return { sha256: digest.digest("hex"), bytes };
}

// Payloads and records are immutable by convention, and always checked by hash.
// Publication uses hard-link create-if-absent, never replacement of evidence.
export class Store {
  constructor(project) {
    this.root = join(resolve(project), ".chipsim", "design");
  }
  blobPath(digest) {
    return join(this.root, "objects", recordId(digest));
  }
  recordPath(id) {
    return join(this.root, "records", recordId(id) + ".json");
  }
  async putFile(file) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > limits.file)
      throw new Error("Expected bounded regular payload: " + file);
    await mkdir(join(this.root, "objects"), { recursive: true });
    const tmp = join(this.root, "objects", "." + randomUUID());
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      await pipeline(
        createReadStream(file),
        new Transform({
          transform(chunk, _encoding, next) {
            bytes += chunk.length;
            if (bytes > limits.file)
              return next(new Error("Payload exceeds size limit"));
            digest.update(chunk);
            next(null, chunk);
          },
        }),
        createWriteStream(tmp, { flags: "wx" }),
      );
      const result = { sha256: digest.digest("hex"), bytes };
      await this.publish(tmp, this.blobPath(result.sha256));
      await this.verifyBlob(result);
      return result;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  async putBytes(bytes) {
    await mkdir(join(this.root, "objects"), { recursive: true });
    const tmp = join(this.root, "objects", "." + randomUUID());
    try {
      await writeFile(tmp, bytes, { flag: "wx" });
      const result = { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
      await this.publish(tmp, this.blobPath(result.sha256));
      await this.verifyBlob(result);
      return result;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  async publish(tmp, destination) {
    try {
      await link(tmp, destination);
      await chmod(destination, 0o444);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  async put(type, body) {
    const record = { ...body, format: "chipsim-" + type, version: VERSION };
    delete record.id;
    const id = identity(record);
    await mkdir(join(this.root, "records"), { recursive: true });
    const tmp = this.recordPath(id) + "." + randomUUID();
    try {
      await writeFile(tmp, JSON.stringify({ ...record, id }, null, 2) + "\n", {
        flag: "wx",
      });
      await this.publish(tmp, this.recordPath(id));
      return await this.get(id);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  async get(id, type) {
    const record = await json(this.recordPath(id));
    const { id: actual, ...body } = record;
    if (
      actual !== id ||
      identity(body) !== id ||
      record.version !== VERSION ||
      !record.format?.startsWith("chipsim-") ||
      (type && record.format !== "chipsim-" + type)
    )
      throw new Error("Evidence record integrity failed: " + id);
    return record;
  }
  async verifyBlob(blob) {
    const result = await fileDigest(this.blobPath(blob.sha256));
    if (result.sha256 !== blob.sha256 || result.bytes !== blob.bytes)
      throw new Error("Payload integrity failed: " + blob.sha256);
  }
  async materialize(entries, destination) {
    for (const entry of entries) {
      const path = join(destination, localPath(entry.path));
      await this.verifyBlob(entry);
      await mkdir(dirname(path), { recursive: true });
      // Never hard-link an immutable blob into a mutable tool workspace.
      await copyFile(this.blobPath(entry.sha256), path);
      await chmod(path, 0o644);
    }
  }
  async list(type) {
    let names;
    try {
      names = await readdir(join(this.root, "records"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const found = [];
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = await this.get(name.slice(0, -5));
      if (!type || record.format === "chipsim-" + type) found.push(record);
    }
    return found;
  }
}
