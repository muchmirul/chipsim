import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  lstat,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { Store, json, files, identity, localPath } from "./store.js";
import { capabilities, payloadKind, normalizeChecks } from "./adapters.js";

export async function publishAttempt(
  store,
  { task, workspace, execution, job, attempt, snapshot, fingerprint, inputs },
) {
  await writeFile(
    join(workspace, "execution.json"),
    JSON.stringify({ ...execution, nativeResult: undefined }, null, 2),
  );
  const checks = await normalizeChecks(task, workspace, execution, inputs);
  const artifacts = [],
    missing = [];
  const inputNames = new Set([
    ...task.inputs.map((i) => i.path),
    ...(task.definition.bindings || []).map((b) => b.path),
  ]);
  const outputs = new Map(
    (task.definition.outputs || []).map((o) => [o.path, o]),
  );
  const paths = await files(workspace);
  for (const path of paths) {
    if (inputNames.has(path) && !outputs.has(path)) continue;
    if (path.startsWith(".owners/")) continue;
    // Retain native build directories but avoid registering thousands of
    // generated compiler objects unless explicitly requested.
    if (/\.(o|a|d)$/.test(path) && !outputs.has(path)) continue;
    const declaration = outputs.get(path),
      kind = declaration?.kind || payloadKind(path, task.definition.adapter);
    const payload = await store.putFile(join(workspace, path));
    artifacts.push(
      await store.put("artifact", {
        kind,
        payloadFormat: declaration?.format || kind,
        path,
        payload,
        producer: { job, attempt, task: task.task },
        snapshot,
        inputs,
        completeness: execution.ok ? "complete" : "partial",
        provenance: "captured",
        capabilities: capabilities(kind),
        context: {
          ...(task.definition.options?.context || {}),
          constraints: inputs
            .filter((i) => i.path.endsWith(".sdc"))
            .map(({ path, sha256 }) => ({ path, sha256 })),
        },
      }),
    );
  }
  for (const output of outputs.values())
    if (
      output.required !== false &&
      !artifacts.some((a) => a.path === output.path)
    )
      missing.push(output.path);
  checks.push({
    name: "outputs",
    verdict: missing.length ? "fail" : "pass",
    scope: "Declared required outputs",
    evidence: artifacts.map((a) => a.path),
    assumptions: [],
    missing,
  });
  if (missing.length)
    for (const check of checks)
      if (
        check.verdict === "pass" &&
        !["execution", "outputs"].includes(check.name)
      )
        check.verdict = "inconclusive";
  const recordedChecks = [];
  for (const c of checks) {
    const evidence = c.evidence
      .map((p) => artifacts.find((a) => a.path === p)?.id)
      .filter(Boolean);
    if (!evidence.length && c.verdict === "pass") c.verdict = "inconclusive";
    recordedChecks.push(
      await store.put("check", {
        ...c,
        evidence,
        subject: { snapshot, task: task.task, fingerprint },
        producer: { job, attempt },
        id: undefined,
      }),
    );
  }
  const record = await store.put("attempt", {
    job,
    attempt,
    task: task.task,
    snapshot,
    fingerprint,
    execution: { ...execution, nativeResult: undefined },
    state:
      execution.reason === "cancelled"
        ? "cancelled"
        : execution.ok
          ? "completed"
          : "failed",
    artifacts: artifacts.map((a) => a.id),
    checks: recordedChecks.map((c) => c.id),
    complete: !missing.length && execution.ok,
    reusable:
      !missing.length &&
      execution.ok &&
      recordedChecks.every((c) => c.verdict === "pass"),
  });
  return record;
}

export async function verifyEvidence(store, id, seen = new Set()) {
  if (seen.has(id)) return;
  seen.add(id);
  const r = await store.get(id);
  if (r.format === "chipsim-artifact") {
    localPath(r.path);
    await store.verifyBlob(r.payload);
    if (r.snapshot) await verifyEvidence(store, r.snapshot, seen);
    for (const input of r.inputs || []) {
      if (input.artifact) await verifyEvidence(store, input.artifact, seen);
      else if (input.sha256) await store.verifyBlob(input);
    }
  } else if (r.format === "chipsim-input-snapshot") {
    for (const file of r.inputs) {
      localPath(file.path);
      await store.verifyBlob(file);
    }
  } else if (r.format === "chipsim-check") {
    for (const artifact of r.evidence)
      await verifyEvidence(store, artifact, seen);
    if (r.subject.snapshot)
      await verifyEvidence(store, r.subject.snapshot, seen);
  } else if (r.format === "chipsim-execution-plan")
    await verifyEvidence(store, r.snapshot, seen);
  else if (["chipsim-attempt", "chipsim-run"].includes(r.format)) {
    if (r.snapshot) await verifyEvidence(store, r.snapshot, seen);
    if (r.plan) await verifyEvidence(store, r.plan, seen);
    for (const ref of [
      ...(r.attempts || []),
      ...(r.artifacts || []),
      ...(r.checks || []),
      ...(r.reusedFrom ? [r.reusedFrom] : []),
    ])
      await verifyEvidence(store, ref, seen);
  }
  return r;
}

export async function publishedArtifacts(store) {
  const ids = new Set();
  for (const run of await store.list("run"))
    for (const id of run.artifacts) ids.add(id);
  return Promise.all([...ids].map((id) => store.get(id, "artifact")));
}
export async function inspectArtifact(
  store,
  id,
  { offset = 0, limit = 16384 } = {},
) {
  const artifact = await verifyEvidence(store, id);
  if (artifact.format !== "chipsim-artifact") return { record: artifact };
  const artifacts = await publishedArtifacts(store);
  const checks = (await store.list("check")).filter((c) =>
    c.evidence.includes(id),
  );
  const consumers = artifacts
    .filter((a) => a.inputs.some((i) => i.artifact === id))
    .map((a) => a.id);
  let preview,
    nextOffset = null;
  if (
    /\.(json|jsonl|txt|log|rpt|v|sv|vhd|vhdl|sdc|tcl|ys|sby|eqy|rdl|h|c|py|xml|csv|chip|md|yml|yaml)$/.test(
      artifact.path,
    )
  ) {
    const { open } = await import("node:fs/promises");
    const handle = await open(store.blobPath(artifact.payload.sha256), "r");
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, offset);
      preview = buffer.subarray(0, bytesRead).toString("utf8");
      if (offset + bytesRead < artifact.payload.bytes)
        nextOffset = offset + bytesRead;
    } finally {
      await handle.close();
    }
  }
  return {
    artifact,
    consumers,
    checks,
    preview,
    nextOffset,
    payloadPath: store.blobPath(artifact.payload.sha256),
  };
}

export async function exportEvidence(store, id, destination) {
  const seen = new Set();
  await verifyEvidence(store, id, seen);
  const root = resolve(destination);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root);
  await mkdir(join(root, "records"));
  await mkdir(join(root, "objects"));
  const blobs = new Map();
  for (const recordId of seen) {
    const r = await store.get(recordId);
    await copyFile(
      store.recordPath(recordId),
      join(root, "records", recordId + ".json"),
    );
    if (r.payload) blobs.set(r.payload.sha256, r.payload);
    if (r.format === "chipsim-input-snapshot")
      for (const file of r.inputs) blobs.set(file.sha256, file);
  }
  for (const blob of blobs.values()) {
    await store.verifyBlob(blob);
    await copyFile(
      store.blobPath(blob.sha256),
      join(root, "objects", blob.sha256),
    );
  }
  const records = [...seen];
  const manifest = {
    format: "chipsim-evidence-bundle",
    version: 1,
    root: id,
    records,
    objects: [...blobs.values()].map(({ sha256, bytes }) => ({
      sha256,
      bytes,
    })),
    replay:
      "Install the toolchain and locked dependencies recorded in the execution plan; inspection is offline.",
  };
  await writeFile(
    join(root, "bundle.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx" },
  );
  return { bundle: root, id, records: records.length, objects: blobs.size };
}

export async function importEvidence(store, source) {
  const root = resolve(source);
  let manifest;
  try {
    manifest = await json(join(root, "bundle.json"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (manifest) {
    if (
      manifest.format !== "chipsim-evidence-bundle" ||
      manifest.version !== 1 ||
      !Array.isArray(manifest.records) ||
      manifest.records.length > 20000 ||
      !Array.isArray(manifest.objects) ||
      manifest.objects.length > 20000
    )
      throw new Error("Invalid evidence bundle");
    const incoming = new Store(root);
    incoming.root = root;
    const closure = new Set();
    await verifyEvidence(incoming, manifest.root, closure);
    if (
      closure.size !== manifest.records.length ||
      manifest.records.some((id) => !closure.has(id))
    )
      throw new Error(
        "Bundle records must match the complete evidence closure",
      );
    // Preflight the whole bundle before making its root visible.
    const referenced = new Map();
    for (const id of manifest.records) {
      const record = await incoming.get(id);
      if (record.payload)
        referenced.set(record.payload.sha256, record.payload.bytes);
      if (record.format === "chipsim-input-snapshot")
        for (const file of record.inputs)
          referenced.set(file.sha256, file.bytes);
    }
    if (
      referenced.size !== manifest.objects.length ||
      new Set(manifest.objects.map((b) => b.sha256)).size !== referenced.size ||
      manifest.objects.some((b) => referenced.get(b.sha256) !== b.bytes)
    )
      throw new Error(
        "Bundle objects must match the complete evidence closure",
      );
    for (const blob of manifest.objects) await incoming.verifyBlob(blob);
    for (const blob of manifest.objects)
      await store.putFile(incoming.blobPath(blob.sha256));
    for (const id of manifest.records.filter((i) => i !== manifest.root)) {
      const r = await incoming.get(id);
      await store.put(r.format.slice(8), r);
    }
    const r = await incoming.get(manifest.root);
    await store.put(r.format.slice(8), r);
    return {
      id: manifest.root,
      provenance: "captured",
      imported: manifest.records.length,
    };
  }
  const artifacts = [];
  for (const path of await files(root)) {
    const kind = payloadKind(path, "legacy");
    artifacts.push(
      await store.put("artifact", {
        path,
        kind,
        payloadFormat: kind,
        payload: await store.putFile(join(root, path)),
        producer: null,
        snapshot: null,
        inputs: [],
        provenance: "unknown",
        completeness: "unknown",
        capabilities: capabilities(kind),
        context: {},
      }),
    );
  }
  const run = await store.put("run", {
    job: null,
    provenance: "unknown",
    state: "imported",
    reusable: false,
    attempts: [],
    artifacts: artifacts.map((a) => a.id),
    checks: [],
    created: new Date().toISOString(),
  });
  return { id: run.id, provenance: "unknown", artifacts: artifacts.length };
}
