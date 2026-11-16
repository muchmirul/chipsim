import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { json, Store } from "../design/store.js";
import { loadDesign } from "../design/project.js";
import { releaseStatus } from "../manufacturing/release.js";
// Inspection deliberately reads persisted states without invoking jobStatus's
// orphan recovery or running project-defined tool/version commands.
export async function workflowStatus(root, args) {
  let names = [];
  try {
    names = await readdir(join(new Store(root).root, "jobs"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const jobs = [];
  for (const id of names.filter((n) => /^[a-f0-9-]{36}$/.test(n))) {
    const s = await json(join(new Store(root).root, "jobs", id, "state.json"));
    jobs.push({
      id,
      target: s.target,
      state: s.state,
      generation: s.generation,
      run: s.run || null,
      ready: s.ready === true,
      updated: s.updated,
    });
  }
  jobs.sort((a, b) => b.updated.localeCompare(a.updated));
  const manifest = await json(join(root, "chipsim.design.json")).catch((e) => {
    if (e.code === "ENOENT") return null;
    return { diagnostic: e.message };
  });
  if (manifest && !manifest.diagnostic) {
    try {
      await loadDesign(root);
    } catch (e) {
      manifest.diagnostic = e.message;
    }
  }
  const release =
    manifest && !manifest.diagnostic
      ? await releaseStatus(root, args.run, { allowMetadataParser: false })
      : null;
  const offset = args.offset || 0,
    limit = args.limit || 20;
  return {
    root,
    candidate: args.candidate || null,
    prepared: !!manifest && !manifest.diagnostic,
    diagnostic: manifest?.diagnostic || null,
    release,
    jobs: jobs.slice(offset, offset + limit),
    total: jobs.length,
    nextOffset: offset + limit < jobs.length ? offset + limit : null,
    nextActions: !manifest
      ? [{ tool: "manufacturing_profiles", arguments: {} }]
      : manifest.diagnostic
        ? [{ tool: "file_read", arguments: { path: "chipsim.design.json" } }]
        : release?.ready
          ? [
              {
                tool: "release_package",
                arguments: { run: release.run },
                needs: ["requestId"],
              },
            ]
          : [{ tool: "validate", arguments: { target: "release" } }],
  };
}
