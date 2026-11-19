import { mkdir, open, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hash, json, atomic, fileDigest } from "../design/store.js";
import { importEvidence } from "../design/evidence.js";
import { problem, withProjectLock } from "./files.js";

export function receiveEvidence(root, store, args) {
  return withProjectLock(root, async () => {
    const dir = join(store.root, "imports", hash(args.requestId));
    await mkdir(dir, { recursive: true });
    const receipt = join(dir, "upload.json"),
      path = join(dir, "evidence.zip");
    let state = await json(receipt).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!state) {
      state = { sha256: args.sha256, bytes: args.bytes, complete: false };
      await atomic(receipt, state);
    }
    if (state.sha256 !== args.sha256 || state.bytes !== args.bytes)
      throw problem(
        "REQUEST_CONFLICT",
        "Upload request identifies another bundle",
      );
    if (state.complete) return state;
    const handle = await open(path, "a+");
    let nextOffset;
    try {
      const offset = args.offset ?? 0,
        data = Buffer.from(args.data || "", "base64");
      if (data.toString("base64") !== (args.data || "") || data.length > 65536)
        throw Error("Invalid base64 chunk");
      nextOffset = (await handle.stat()).size;
      if (data.length) {
        if (offset > nextOffset || offset + data.length > args.bytes)
          throw problem("BYTE_RANGE", "Invalid upload offset");
        const overlap = Math.min(nextOffset - offset, data.length);
        const prefix = Buffer.alloc(overlap);
        if (
          (await handle.read(prefix, 0, overlap, offset)).bytesRead !==
            overlap ||
          !prefix.equals(data.subarray(0, overlap))
        )
          throw problem("EDIT_CONFLICT", "Conflicting upload bytes");
        if (overlap < data.length) {
          await handle.writeFile(data.subarray(overlap));
          await handle.sync();
          nextOffset = offset + data.length;
        }
      }
    } finally {
      await handle.close();
    }
    if (!args.finish) return { ...state, nextOffset };
    if (
      nextOffset !== args.bytes ||
      (await fileDigest(path)).sha256 !== args.sha256
    )
      throw Error("Incomplete or corrupt evidence ZIP");
    const staged = await mkdtemp(join(dir, "staged-"));
    try {
      await promisify(execFile)(
        "python3",
        [
          fileURLToPath(
            new URL("../../scripts/unpack-evidence.py", import.meta.url),
          ),
          path,
          staged,
        ],
        { timeout: 300000 },
      );
      const result = await importEvidence(store, staged);
      state = { ...state, complete: true, nextOffset, ...result };
      await atomic(receipt, state);
      await rm(path, { force: true });
      return state;
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  });
}
