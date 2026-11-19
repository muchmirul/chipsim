import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { json, Store, identity } from "../design/store.js";
import { loadDesign, verifyDependencies } from "../design/project.js";
import { releaseStatus } from "../manufacturing/release.js";
import { verifyEvidence } from "../design/evidence.js";
import { manufacturingProfile } from "../manufacturing/profiles.js";
import { checksForTarget, projectSummary } from "../design/service.js";
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const action = (tool, args = {}, needs = []) => ({
  tool,
  arguments: args,
  ...(needs.length ? { needs } : {}),
});
export async function workflowStatus(root, args) {
  const store = new Store(root);
  let names = [];
  try {
    names = await readdir(join(store.root, "jobs"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const jobs = [];
  for (const id of names.filter((n) => /^[a-f0-9-]{36}$/.test(n))) {
    const s = await json(join(store.root, "jobs", id, "state.json"));
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
  jobs.sort(
    (a, b) => b.updated.localeCompare(a.updated) || b.id.localeCompare(a.id),
  );
  let design = null,
    diagnostic = null;
  let diagnosticPath = "chipsim.design.json";
  try {
    design = await loadDesign(root);
  } catch (e) {
    diagnostic = e.message;
    diagnosticPath = e.projectFile || diagnosticPath;
  }
  let stage = "profile-selection",
    nextActions = [action("manufacturing_profiles")],
    release = null;
  const active = jobs.find((j) => !terminal.has(j.state));
  const preparation = {
    environment: null,
    bootstrap: false,
    pendingBootstrapRequests: [],
  };
  let receipts = [];
  try {
    receipts = await readdir(join(root, ".chipsim/bootstrap-requests"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const name of receipts.filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
    const receipt = await json(join(root, ".chipsim/bootstrap-requests", name));
    if (!receipt.complete)
      preparation.pendingBootstrapRequests.push(name.slice(0, -5));
  }
  if (active) {
    stage = "job-active";
    nextActions = [
      action("job_status", { job: active.id, waitMs: 10000 }),
      action("job_logs", { job: active.id, offset: 0 }),
    ];
  } else if (!design) {
    // A successful setup is useful only if the complete evidence is intact and
    // refers to the current profile. No configured parser or probe is executed.
    const setup = jobs.find(
      (j) =>
        j.target === "manufacturing-setup" &&
        j.state === "completed" &&
        j.ready,
    );
    if (setup?.run) {
      try {
        const run = await verifyEvidence(store, setup.run);
        const artifacts = await Promise.all(
          run.artifacts.map((id) => store.get(id, "artifact")),
        );
        const a = artifacts.find((a) => a.path === "environment.json");
        const env = await json(store.blobPath(a.payload.sha256));
        const profile = await manufacturingProfile(env.profile);
        if (
          run.target !== "manufacturing-setup" ||
          run.state !== "completed" ||
          !run.readiness.ready
        )
          throw Error("Setup evidence is not ready");
        const { identity: recorded, ...body } = env;
        if (identity(body) !== recorded)
          throw Error("Setup environment identity differs");
        await verifyDependencies(env.dependencies, root);
        if (env.digest !== profile.digest) throw Error("Setup profile changed");
        preparation.environment = { run: setup.run, profile: env.profile };
        stage = "bootstrap";
        nextActions = [
          action(
            "project_bootstrap",
            { profile: env.profile, environment: setup.run },
            ["metadata", "requestId"],
          ),
        ];
      } catch (e) {
        diagnostic = e.message;
        stage = "setup-invalid";
        nextActions = [action("evidence", { id: setup.run })];
      }
    }
    // Existing malformed drafts must be repaired rather than overwritten.
    try {
      await json(join(root, "chipsim.design.json"));
      if (diagnostic) {
        stage = "repair-manifest";
        nextActions = [action("file_read", { path: diagnosticPath })];
      }
    } catch (e) {
      if (e.code !== "ENOENT" && !preparation.environment) {
        stage = "repair-manifest";
        nextActions = [action("file_read", { path: "chipsim.design.json" })];
      }
    }
    if (!setup && jobs[0]?.target === "manufacturing-setup") {
      stage = "setup-failed";
      nextActions = [
        action("job_status", { job: jobs[0].id }),
        action("job_logs", { job: jobs[0].id }),
      ];
    }
  } else {
    preparation.bootstrap = true;
    if (design.config.targets.release)
      release = await releaseStatus(root, args.run, {
        allowMetadataParser: false,
      });
    const failed = jobs.find((j) => j.state !== "completed");
    if (release?.ready) {
      const packaged = jobs.find(
        (j) =>
          j.target === "manufacturing-package" &&
          j.state === "completed" &&
          j.ready,
      );
      let matches = false;
      if (packaged?.run) {
        try {
          const r = await verifyEvidence(store, packaged.run);
          const p = await store.get(r.plan, "execution-plan");
          if (
            p.tasks.some(
              (t) => t.definition.options?.request?.run === release.run,
            )
          ) {
            const artifacts = await Promise.all(
              r.artifacts.map((id) => store.get(id, "artifact")),
            );
            const delivery = artifacts.find(
              (a) => a.path === "release-manifest.json",
            );
            const manifest =
              delivery && (await json(store.blobPath(delivery.payload.sha256)));
            matches =
              !!manifest?.policy &&
              identity(manifest.policy) === identity(release.comparison);
          }
        } catch (e) {
          diagnostic = e.message;
        }
      }
      stage = matches ? "delivery-ready" : "package";
      nextActions = matches
        ? [action("artifacts", { run: packaged.run })]
        : [action("release_package", { run: release.run }, ["requestId"])];
    } else if (failed && failed.updated === jobs[0]?.updated) {
      stage = "inspect-failure";
      nextActions = [
        action("job_status", { job: failed.id }),
        action("job_logs", { job: failed.id }),
      ];
    } else {
      const target = design.config.targets.simulation
        ? "simulation"
        : design.config.targets.release
          ? "release"
          : Object.keys(design.config.targets)[0];
      const simulation = target
        ? await checksForTarget(
            root,
            target,
            undefined,
            await projectSummary(root, {
              target,
              latestOnly: true,
              recoverJobs: false,
            }),
          )
        : null;
      stage = simulation?.ready
        ? design.config.targets.release
          ? "release"
          : "verified"
        : "implement-and-verify";
      const runTarget =
        simulation?.ready && design.config.targets.release ? "release" : target;
      nextActions =
        stage === "verified"
          ? []
          : [
              action("validate", { target: runTarget }),
              action("job_start", { target: runTarget, reuse: false }, [
                "requestId",
              ]),
            ];
    }
  }
  if (!active && preparation.pendingBootstrapRequests.length) {
    stage = "bootstrap-recovery";
    nextActions = [
      action(
        "project_bootstrap",
        preparation.environment
          ? {
              profile: preparation.environment.profile,
              environment: preparation.environment.run,
            }
          : {},
        ["original metadata", "original requestId"],
      ),
    ];
  }
  const offset = args.offset || 0,
    limit = args.limit || 20;
  return {
    root,
    candidate: args.candidate || null,
    prepared: !!design,
    preparation,
    stage,
    diagnostic,
    release,
    jobs: jobs.slice(offset, offset + limit),
    total: jobs.length,
    nextOffset: offset + limit < jobs.length ? offset + limit : null,
    nextActions: nextActions.map((a) =>
      args.candidate
        ? { ...a, arguments: { ...a.arguments, candidate: args.candidate } }
        : a,
    ),
  };
}
