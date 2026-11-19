import { constants } from "node:fs";
import {
  open,
  lstat,
  mkdir,
  rename,
  rm,
  realpath,
  readdir,
  chmod,
  copyFile,
  unlink,
  rmdir,
  readFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  files,
  hash,
  identity,
  Store,
  atomic,
  json,
  localPath,
} from "../design/store.js";
import { processIdentity, alive } from "../design/process.js";

export const textLimit = 1048576;
export const problem = (code, message, details) =>
  Object.assign(new Error(message), { code, details });
const hidden = new Set([".git", ".chipsim", ".chipsim-agent", "node_modules"]);
export function editable(path) {
  localPath(path);
  if (path.split("/").some((part) => hidden.has(part)))
    throw problem(
      "RESERVED_PATH",
      "Internal stores and dependencies are not editable project files",
    );
  return path;
}
export async function safePath(root, path, create = false) {
  editable(path);
  let full = root;
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    full = join(full, parts[i]);
    let info;
    try {
      info = await lstat(full);
    } catch (e) {
      if (e.code !== "ENOENT" || !create) throw e;
      if (i < parts.length - 1)
        await mkdir(full).catch((e) => {
          if (e.code !== "EEXIST") throw e;
        });
      else return full;
      info = await lstat(full);
    }
    if (
      info.isSymbolicLink() ||
      (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())
    )
      throw problem(
        "UNSAFE_PATH",
        "Expected regular project path without symbolic links: " + path,
      );
  }
  return full;
}
export async function readText(root, path) {
  const full = await safePath(root, path);
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > textLimit)
      throw problem("FILE_LIMIT", "Text files are limited to 1 MiB");
    const bytes = await handle.readFile();
    if (bytes.length > textLimit)
      throw problem("FILE_LIMIT", "Text files are limited to 1 MiB");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw problem("BINARY_FILE", "Expected UTF-8 text");
    }
    if (text.includes("\0"))
      throw problem("BINARY_FILE", "Expected UTF-8 text without NUL");
    return { path, text, sha256: hash(bytes), bytes: bytes.length };
  } finally {
    await handle.close();
  }
}

// Cooperating CLI/MCP clients serialize mutations. A dead process is reported,
// never silently broken: removing a lock while another client acquires it races.
export async function withProjectLock(root, action) {
  const dir = join(root, ".chipsim", "workbench-lock");
  await mkdir(dirname(dir), { recursive: true });
  for (let n = 0; ; n++) {
    try {
      await mkdir(dir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (n >= 600) {
        const owner = await json(join(dir, "owner.json")).catch(() => null);
        throw problem(
          "PROJECT_BUSY",
          "Project mutation lock is occupied. Retry; if its owner stopped, remove the reported lock while clients are stopped.",
          { lock: dir, owner, ownerAlive: await alive(owner) },
        );
      }
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  try {
    await atomic(join(dir, "owner.json"), await processIdentity(process.pid));
    const receipt = await json(
      join(root, ".chipsim", "pending-apply.json"),
    ).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (receipt) await finishApply(root, new Store(root), receipt);
    return await action();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function writeText(root, { path, text, expectedHash }) {
  if (Buffer.byteLength(text) > textLimit || text.includes("\0"))
    throw problem(
      "FILE_LIMIT",
      "Expected at most 1 MiB UTF-8 text without NUL",
    );
  return withProjectLock(root, async () => {
    const full = await safePath(root, path, true);
    const previous = await readText(root, path).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if ((previous?.sha256 ?? null) !== expectedHash)
      throw problem(
        "EDIT_CONFLICT",
        "File changed; read it and retry with its current hash",
        { path, expectedHash, actualHash: previous?.sha256 ?? null },
      );
    const temporary = full + "." + randomUUID() + ".tmp";
    const mode = previous ? (await lstat(full)).mode & 0o777 : 0o644;
    try {
      const handle = await open(temporary, "wx", mode);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, full);
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      path,
      sha256: hash(Buffer.from(text)),
      bytes: Buffer.byteLength(text),
      previousHash: previous?.sha256 ?? null,
    };
  });
}
export async function revision(
  root,
  { capture = false, store = new Store(root) } = {},
) {
  const inputs = [];
  for (const path of await files(root)) {
    const full = await safePath(root, path);
    const { fileDigest } = await import("../design/store.js");
    inputs.push({
      path,
      ...(capture ? await store.putFile(full) : await fileDigest(full)),
      mode: (await lstat(full)).mode & 0o777,
    });
  }
  const body = { inputs };
  return capture
    ? store.put("workbench-revision", body)
    : {
        ...body,
        id: identity({
          ...body,
          format: "chipsim-workbench-revision",
          version: 1,
        }),
      };
}
export async function candidateRoot(root, id) {
  if (!id) return root;
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw problem("INVALID_CANDIDATE", "Expected candidate UUID");
  const base = join(root, ".chipsim", "candidates", id);
  const record = await json(join(base, "candidate.json"));
  if (record.id !== id || record.project !== root)
    throw problem("INVALID_CANDIDATE", "Candidate belongs to another project");
  const dir = join(base, "project");
  if ((await realpath(dir)) !== dir)
    throw problem("UNSAFE_PATH", "Candidate path cannot be a symbolic link");
  return dir;
}
async function candidateRecords(root) {
  const dir = join(root, ".chipsim", "candidates");
  const names = await readdir(dir).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  const records = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    records.push(await json(join(dir, name, "candidate.json")));
  }
  return records;
}

export async function listCandidates(
  root,
  parent,
  { offset = 0, limit = 100, requestId },
) {
  const records = (await candidateRecords(root)).filter(
    (r) =>
      (!parent || r.parent === parent) &&
      (!requestId || r.requestId === requestId),
  );
  return {
    items: records.slice(offset, offset + limit),
    total: records.length,
    nextOffset: offset + limit < records.length ? offset + limit : null,
  };
}

export async function createCandidate(root, label, parent, requestId) {
  return withProjectLock(root, async () => {
    const source = await candidateRoot(root, parent);
    if (requestId) {
      const prior = (await candidateRecords(root)).find(
        (r) => r.requestId === requestId && r.parent === (parent || null),
      );
      if (prior) {
        if (prior.label !== label)
          throw problem(
            "REQUEST_CONFLICT",
            "Candidate request was already used with another label",
          );
        return {
          ...prior,
          directory: await candidateRoot(root, prior.id),
          revision: prior.baseRevision,
        };
      }
    }
    const store = new Store(source);
    const capture = () => revision(source, { capture: true, store });
    const base =
      source === root
        ? await capture()
        : await withProjectLock(source, capture);
    const id = randomUUID();
    const dir = join(root, ".chipsim", "candidates", id);
    const temporary = dir + ".pending";
    const record = {
      id,
      label,
      project: root,
      parent: parent || null,
      requestId: requestId || null,
      baseRevision: base.id,
      created: new Date().toISOString(),
    };
    try {
      const project = join(temporary, "project");
      await mkdir(project, { recursive: true });
      await store.materialize(base.inputs, project);
      for (const entry of base.inputs)
        await chmod(join(project, entry.path), entry.mode);
      await atomic(join(temporary, "candidate.json"), record);
      await rename(temporary, dir);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
    return { ...record, directory: join(dir, "project"), revision: base.id };
  });
}

function changedFiles(base, next) {
  const before = new Map(base.inputs.map((e) => [e.path, e]));
  const after = new Map(next.inputs.map((e) => [e.path, e]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((path) => {
      const old = before.get(path) || null,
        updated = after.get(path) || null;
      return old?.sha256 === updated?.sha256 && old?.mode === updated?.mode
        ? []
        : [{ path, before: old, after: updated }];
    });
}

async function candidateVersions(root, id, capture = false) {
  if (!id) throw problem("INVALID_CANDIDATE", "Select a candidate");
  const source = await candidateRoot(root, id);
  const record = await json(join(dirname(source), "candidate.json"));
  const target = await candidateRoot(root, record.parent);
  const store = new Store(target);
  const base = await store.get(record.baseRevision, "workbench-revision");
  const next = capture
    ? await withProjectLock(source, () =>
        revision(source, { capture: true, store }),
      )
    : await revision(source);
  return { target, store, base, next };
}

export async function candidateDiff(
  root,
  { candidate, offset = 0, limit = 100 },
) {
  const { base, next } = await candidateVersions(root, candidate);
  const changes = changedFiles(base, next);
  return {
    baseRevision: base.id,
    revision: next.id,
    items: changes.slice(offset, offset + limit),
    total: changes.length,
    nextOffset: offset + limit < changes.length ? offset + limit : null,
  };
}

async function finishApply(target, store, receipt) {
  const base = await store.get(receipt.base, "workbench-revision");
  const next = await store.get(receipt.next, "workbench-revision");
  const current = await revision(target);
  const pending = changedFiles(current, next);
  const original = new Map(base.inputs.map((e) => [e.path, e]));
  for (const item of pending) {
    const old = original.get(item.path);
    if (item.before?.sha256 !== old?.sha256 || item.before?.mode !== old?.mode)
      throw problem("EDIT_CONFLICT", "File changed during candidate apply", {
        path: item.path,
      });
    if (item.after) await store.verifyBlob(item.after);
  }
  for (const { path } of pending.filter((i) => !i.after)) {
    await unlink(await safePath(target, path));
    // Remove only empty ancestors left by this patch (directory-to-file edits).
    for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
      try {
        await rmdir(join(target, dir));
      } catch (error) {
        if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) break;
        throw error;
      }
    }
  }
  for (const { path, after } of pending.filter((i) => i.after)) {
    const dest = await safePath(target, path, true);
    const tmp = join(store.root, "apply-" + randomUUID());
    try {
      await copyFile(store.blobPath(after.sha256), tmp);
      await chmod(tmp, after.mode);
      await rename(tmp, dest);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  if ((await revision(target)).id !== next.id)
    throw problem("EDIT_CONFLICT", "Project changed during candidate apply");
  await unlink(join(target, ".chipsim", "pending-apply.json"));
}

export async function applyCandidate(root, args) {
  const { target, store, base, next } = await candidateVersions(
    root,
    args.candidate,
    true,
  );
  if (
    args.expectedCandidateRevision &&
    args.expectedCandidateRevision !== next.id
  )
    throw problem("EDIT_CONFLICT", "Candidate changed after diff");
  if (args.expectedRevision !== base.id)
    throw problem(
      "EDIT_CONFLICT",
      "Expected revision differs from candidate base",
    );
  return withProjectLock(target, async () => {
    const previous = (await revision(target)).id;
    if (previous === next.id)
      return { revision: next.id, baseRevision: base.id };
    if (previous !== base.id)
      throw problem("EDIT_CONFLICT", "Destination has changed", {
        expectedHash: base.id,
        actualHash: previous,
      });
    const receipt = { base: base.id, next: next.id };
    await atomic(join(target, ".chipsim", "pending-apply.json"), receipt);
    await finishApply(target, store, receipt);
    return { revision: next.id, baseRevision: base.id };
  });
}

export async function fileList(
  root,
  { offset = 0, limit = 100, query = "" } = {},
) {
  const all = (await files(root)).filter((path) => path.includes(query));
  return {
    items: all.slice(offset, offset + limit),
    total: all.length,
    nextOffset: offset + limit < all.length ? offset + limit : null,
  };
}
export async function fileSearch(root, { query, offset = 0, limit = 100 }) {
  const matches = [];
  let total = 0;
  const skipped = [];
  for (const path of await files(root)) {
    let source;
    try {
      source = await readText(root, path);
    } catch (e) {
      if (["BINARY_FILE", "FILE_LIMIT"].includes(e.code)) {
        skipped.push(path);
        continue;
      }
      throw e;
    }
    const lines = source.text.split("\n");
    for (let i = 0; i < lines.length; i++)
      if (lines[i].includes(query)) {
        if (total >= offset && matches.length < limit)
          matches.push({
            path,
            line: i + 1,
            text: lines[i].slice(0, 1024),
            sha256: source.sha256,
          });
        total++;
      }
  }
  return {
    items: matches,
    total,
    nextOffset: offset + limit < total ? offset + limit : null,
    skipped: skipped.slice(0, 100),
    skippedTotal: skipped.length,
  };
}
