import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const sha = (b) => createHash("sha256").update(b).digest("hex");
// Byte-transport fixtures establish client integrity behavior, not native EDA.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from(Array.from({ length: 180123 }, (_, i) => i % 251));
  const artifact = { id: "a".repeat(64), bytes: bytes.length };
  let reads = [];
  const call = async (name, a) => {
    assert.equal(name, "artifact_read");
    reads.push(a.offset);
    const b = bytes.subarray(a.offset, a.offset + a.limit);
    return {
      data: b.toString("base64"),
      sha256: sha(bytes),
      chunkSha256: sha(b),
      nextOffset:
        a.offset + b.length === bytes.length ? null : a.offset + b.length,
    };
  };
  let downloadArtifact;
  try {
    ({ downloadArtifact } = await import("../extensions/mcp/workflow.mjs"));
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("Install optional MCP SDK");
      return;
    }
    throw e;
  }
  return {
    root,
    target: join(root, "evidence.zip"),
    bytes,
    artifact,
    call,
    reads,
    downloadArtifact,
  };
}
test("interrupted download validates and resumes exact prefix, including a partial chunk", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  let progress = [];
  await assert.rejects(
    f.downloadArtifact(f.call, f.artifact, f.target, async (p) => {
      progress.push(p);
      throw Error("client disconnected");
    }),
    /disconnected/,
  );
  assert.equal((await stat(f.target + ".partial")).size, 65536);
  await assert.rejects(stat(f.target), { code: "ENOENT" });
  // Partial filesystem write before abrupt death is also supported.
  await writeFile(f.target + ".partial", f.bytes.subarray(0, 70001));
  const r = await f.downloadArtifact(f.call, f.artifact, f.target, (p) =>
    progress.push(p),
  );
  assert.equal(r.sha256, sha(f.bytes));
  assert.deepEqual(await readFile(f.target), f.bytes);
  assert.equal(progress.at(-1).verifiedBytes, f.bytes.length);
  await assert.rejects(stat(f.target + ".partial"), { code: "ENOENT" });
  assert.deepEqual(await f.downloadArtifact(f.call, f.artifact, f.target), r);
});
test("corrupted prefix, destination conflict, chunk corruption, identity changes and bad cursors never publish", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  await writeFile(f.target + ".partial", Buffer.from("wrong"));
  await assert.rejects(
    f.downloadArtifact(f.call, f.artifact, f.target),
    /Partial download differs/,
  );
  await rm(f.target + ".partial");
  for (const mutate of [
    (p) => ({ ...p, chunkSha256: "bad" }),
    (p) => ({ ...p, nextOffset: 1 }),
    (p) => ({ ...p, data: "" }),
  ]) {
    await assert.rejects(
      f.downloadArtifact(
        async (n, a) => mutate(await f.call(n, a)),
        f.artifact,
        f.target,
      ),
    );
    await assert.rejects(stat(f.target), { code: "ENOENT" });
    await rm(f.target + ".partial", { force: true });
  }
  await assert.rejects(
    f.downloadArtifact(
      async (n, a) => {
        const p = await f.call(n, a);
        return a.offset ? { ...p, sha256: "bad" } : p;
      },
      f.artifact,
      f.target,
    ),
    /integrity/,
  );
  await assert.rejects(stat(f.target), { code: "ENOENT" });
  await writeFile(f.target, "existing user file");
  await assert.rejects(
    f.downloadArtifact(f.call, f.artifact, f.target),
    /Conflicting destination/,
  );
  assert.equal(await readFile(f.target, "utf8"), "existing user file");
});
test("exclusive publication preserves a destination created by another client", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  await assert.rejects(
    f.downloadArtifact(f.call, f.artifact, f.target, async (p) => {
      if (p.verifiedBytes === f.bytes.length)
        await writeFile(f.target, "other client");
    }),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(f.target, "utf8"), "other client");
});

test("symlinked partial files cannot redirect download writes", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { symlink } = await import("node:fs/promises");
  const userFile = join(f.root, "user.txt");
  await writeFile(userFile, "preserve");
  await symlink(userFile, f.target + ".partial");
  await assert.rejects(
    f.downloadArtifact(f.call, f.artifact, f.target),
    /regular/,
  );
  assert.equal(await readFile(userFile, "utf8"), "preserve");
});
