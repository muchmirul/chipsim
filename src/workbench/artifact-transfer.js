import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { verifyEvidence } from "../design/evidence.js";
import { hash } from "../design/store.js";
import { problem } from "./files.js";

const blockSize = 65536;
async function block(handle, offset, bytes) {
  const buffer = Buffer.alloc(bytes);
  let position = 0;
  while (position < bytes) {
    const { bytesRead } = await handle.read(
      buffer,
      position,
      bytes - position,
      offset + position,
    );
    if (!bytesRead) throw Error("Truncated artifact payload");
    position += bytesRead;
  }
  return buffer;
}

async function indexArtifact(store, id) {
  const record = await store.get(id, "artifact");
  const { sha256, bytes } = record.payload;
  const digest = createHash("sha256"),
    blocks = [];
  const handle = await open(store.blobPath(sha256), "r");
  try {
    if ((await handle.stat()).size !== bytes)
      throw Error("Payload length differs");
    for (let i = 0; i < bytes; i += blockSize) {
      const data = await block(handle, i, Math.min(blockSize, bytes - i));
      digest.update(data);
      blocks.push(hash(data));
    }
  } finally {
    await handle.close();
  }
  if (digest.digest("hex") !== sha256)
    throw Error("Artifact payload integrity failed");
  await verifyEvidence(store, id, new Set(), new Set([sha256 + ":" + bytes]));
  return { record, blocks };
}

// Only digests survive a call. Rechecking complete aligned blocks authenticates
// arbitrary ranges even when another process replaces or edits the backing file.
export function artifactReader() {
  const transfers = new Map();
  return async (store, { artifact, offset = 0, limit = blockSize }) => {
    const key = store.root + "/" + artifact;
    let transfer = transfers.get(key);
    if (!transfer || !offset || Date.now() - transfer.used > 60000) {
      transfer = await indexArtifact(store, artifact);
      if (transfers.size >= 8) transfers.delete(transfers.keys().next().value);
      transfers.set(key, transfer);
    }
    transfer.used = Date.now();
    const { sha256, bytes } = transfer.record.payload;
    if (offset > bytes)
      throw problem("BYTE_RANGE", "Offset exceeds artifact size");
    const end = Math.min(bytes, offset + limit),
      parts = [];
    const handle = await open(store.blobPath(sha256), "r");
    try {
      if ((await handle.stat()).size !== bytes)
        throw Error("Payload length differs");
      for (
        let i = Math.floor(offset / blockSize) * blockSize;
        i < end;
        i += blockSize
      ) {
        const data = await block(handle, i, Math.min(blockSize, bytes - i));
        if (hash(data) !== transfer.blocks[i / blockSize])
          throw Error("Artifact block integrity failed");
        parts.push(data.subarray(Math.max(0, offset - i), end - i));
      }
    } finally {
      await handle.close();
    }
    const data = Buffer.concat(parts);
    if (end === bytes) transfers.delete(key);
    return {
      artifact,
      path: transfer.record.path,
      sha256,
      bytes,
      offset,
      length: data.length,
      chunkSha256: hash(data),
      encoding: "base64",
      data: data.toString("base64"),
      nextOffset: end < bytes ? end : null,
    };
  };
}
