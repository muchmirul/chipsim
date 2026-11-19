import { requirementCoverage } from "./coverage.js";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store, json, fileDigest, identity } from "../design/store.js";
import { loadDesign } from "../design/project.js";
import { checksForTarget, projectSummary } from "../design/service.js";
import { verifyEvidence, exportEvidence } from "../design/evidence.js";
import { execute } from "../design/process.js";
import { parseXunit } from "../design/xunit.js";
import { dockerEnvironment } from "./docker.js";
import { manufacturingProfile } from "./profiles.js";

export async function releaseStatus(
  root,
  runId,
  { allowMetadataParser = true, inspectOnly = false } = {},
) {
  const blockers = [];
  const status = {
    ready: false,
    run: runId || null,
    blockers,
    required: [],
    deliverables: [],
  };
  try {
    const { config, store } = await loadDesign(root);
    const settings = await json(join(root, "manufacturing.json"));
    const profile = await manufacturingProfile(settings.profile);
    status.profile = profile.id;
    if (settings.profileDigest !== profile.digest)
      blockers.push("Manufacturing profile identity changed");
    const run = runId
      ? await verifyEvidence(store, runId)
      : (await store.list("run"))
          .filter((r) => r.target === "release")
          .sort((a, b) => b.created.localeCompare(a.created))[0];
    if (!run || run.format !== "chipsim-run" || run.target !== "release")
      throw new Error("No captured release run");
    status.run = run.id;
    const captured = await verifyEvidence(store, run.id),
      plan = await store.get(run.plan, "execution-plan"),
      snapshot = await store.get(run.snapshot, "input-snapshot");
    const summary = inspectOnly
      ? await projectSummary(root, {
          target: "release",
          runId: run.id,
          recoverJobs: false,
        })
      : undefined;
    const checks = await checksForTarget(root, "release", run.id, summary);
    status.required = checks.required;
    status.comparison = checks.comparison;
    status.changes = checks.changes;
    if (checks.reasonCode)
      blockers.push(checks.reasonCode + ": " + checks.reason);
    status.verification = {
      checks: (checks.checks || []).map((c) => ({
        id: c.id,
        name: c.name,
        task: c.subject?.task,
        verdict: c.verdict,
        freshness:
          checks.required.find((r) => r.check === c.id)?.verdict === "stale"
            ? "stale"
            : "captured",
        scope: c.scope,
        assumptions: c.assumptions,
        context: c.context,
        evidence: c.evidence,
        metrics: c.metrics,
        cases: c.cases,
        expectedCases: c.expectedCases,
        missingCases: c.missingCases,
      })),
      proofs: Object.entries(config.tasks)
        .filter(([, t]) => ["sby", "eqy"].includes(t.adapter))
        .map(([task, t]) => ({
          task,
          adapter: t.adapter,
          check:
            checks.required.find(
              (c) =>
                c.name ===
                task + ":" + (t.adapter === "sby" ? "formal" : "equivalence"),
            ) || null,
        })),
      unverified: [
        "Completeness of authored requirements and tests",
        "Analog behavior",
        "Manufacturer acceptance",
      ],
    };
    if (!checks.ready || captured.state !== "completed")
      blockers.push(
        "Required release checks have not all passed for the current project",
      );
    for (const key of profile.requiredChecks)
      if (
        !config.targets.release.requiredChecks?.includes(key) ||
        !plan.policy.requiredChecks?.includes(key)
      )
        blockers.push("Mandatory profile check removed: " + key);
    for (const [key, task] of Object.entries(config.tasks))
      if (["sby", "eqy"].includes(task.adapter)) {
        const check =
          key + ":" + (task.adapter === "sby" ? "formal" : "equivalence");
        if (
          !checks.required.some((r) => r.name === check && r.verdict === "pass")
        )
          blockers.push("Declared proof must pass: " + check);
      }
    const expected = {
      rtl: ["tinytapeout-verify", "rtl"],
      synthesis: ["tinytapeout-verify", "synthesis"],
      physical: ["tinytapeout", null],
      gate: ["tinytapeout-verify", "gate"],
    };
    for (const [key, [adapter, operation]] of Object.entries(expected)) {
      const task = plan.tasks.find((t) => t.task === key);
      if (
        task?.definition.adapter !== adapter ||
        (operation && task.definition.options.operation !== operation)
      ) {
        blockers.push("Required manufacturing task changed: " + key);
        continue;
      }
      const o = task.definition.options;
      if (o.image !== profile.pins.image)
        blockers.push("Tool container differs from profile: " + key);
      if (key === "physical")
        for (const [pin, value] of Object.entries(profile.pins))
          if (o[pin] !== value)
            blockers.push("Physical pin differs from profile: " + pin);
      if (operation && o.top !== settings.metadata.top)
        blockers.push("Top module differs: " + key);
    }
    const infoInput = snapshot.inputs.find((p) => p.path === "info.yaml");
    const physicalOptions = plan.tasks.find((t) => t.task === "physical")
      ?.definition.options;
    if (infoInput && physicalOptions) {
      const raw = await readFile(store.blobPath(infoInput.sha256), "utf8");
      let info;
      try {
        info = JSON.parse(raw);
      } catch {
        if (!allowMetadataParser)
          throw new Error(
            "YAML metadata requires explicit release_status inspection; workflow discovery does not execute configured parsers",
          );
        const result = await new Promise((resolve, reject) => {
          const child = execFile(
            physicalOptions.python,
            [
              "-c",
              "import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))",
            ],
            {
              timeout: 5000,
              maxBuffer: 1048576,
              env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
            },
            (error, stdout) => (error ? reject(error) : resolve({ stdout })),
          );
          child.stdin.end(raw);
        });
        info = JSON.parse(result.stdout);
      }
      const project = info.project;
      if (
        project?.top_module !== settings.metadata.top ||
        project?.clock_hz !== settings.metadata.clockHz ||
        project?.tiles !== settings.metadata.tiles
      )
        blockers.push(
          "Submission top, clock or tile metadata differs from the declared design",
        );
      for (const field of ["title", "author", "description"])
        if (typeof project?.[field] !== "string" || !project[field].trim())
          blockers.push("Incomplete submission metadata: " + field);
      for (const prefix of ["ui", "uo", "uio"])
        for (let i = 0; i < 8; i++)
          if (typeof info.pinout?.[prefix + "[" + i + "]"] !== "string")
            blockers.push("Missing pin description: " + prefix + "[" + i + "]");
      const flowInput = snapshot.inputs.find(
        (p) => p.path === "src/config.json",
      );
      if (
        !flowInput ||
        JSON.parse(await readFile(store.blobPath(flowInput.sha256), "utf8"))
          .CLOCK_PERIOD !==
          1e9 / settings.metadata.clockHz
      )
        blockers.push(
          "Captured physical clock period differs from the specified clock frequency",
        );
      const sources = project?.source_files?.map((p) => "src/" + p).sort();
      for (const key of ["rtl", "synthesis"])
        if (
          identity(sources) !==
          identity(
            [
              ...(plan.tasks.find((t) => t.task === key)?.definition.options
                .sources || []),
            ].sort(),
          )
        )
          blockers.push(
            "Verified RTL sources differ from physical submission sources: " +
              key,
          );
    }
    const gate = plan.tasks.find((t) => t.task === "gate");
    if (
      !gate?.definition.bindings?.some(
        (b) =>
          b.task === "physical" &&
          b.path === "gate_level_netlist.v" &&
          b.output === "tt_submission/" + settings.metadata.top + ".v",
      )
    )
      blockers.push(
        "Gate-level tests are not bound to the delivered physical netlist",
      );
    const acceptanceInput = snapshot.inputs.find(
      (p) => p.path === "acceptance.json",
    );
    if (acceptanceInput)
      status.verification.requirements = requirementCoverage(
        await json(store.blobPath(acceptanceInput.sha256)),
        config.engineering?.requirements || [],
      );
    status.verification.requirementResults = checks.requirementResults || [];
    for (const entry of status.verification.requirementResults)
      if (entry.verdict === "missing")
        blockers.push(
          "Missing " +
            entry.kind +
            " evidence for requirement " +
            entry.id +
            " (" +
            entry.cases.join(", ") +
            ")",
        );
    const source = snapshot.inputs.find((p) => p.path === "manufacturing.json");
    if (
      !source ||
      source.sha256 !==
        (await fileDigest(join(root, "manufacturing.json"))).sha256
    )
      blockers.push("Manufacturing metadata is missing or stale");
    const artifacts = await Promise.all(
      run.artifacts.map((a) => store.get(a, "artifact")),
    );
    const native = artifacts.filter((a) => a.producer.task === "physical");
    const top = "tt_submission/" + settings.metadata.top;
    const required = [
      top + ".gds",
      top + ".oas",
      top + ".lef",
      top + ".v",
      "tt_submission/pdk.json",
      "tt_submission/resolved.json",
      "tt_submission/commit_id.json",
      "tt_submission/stats/metrics.csv",
      "tt_submission/stats/synthesis-stats.txt",
    ];
    for (const path of required) {
      const a = native.find(
        (a) =>
          a.path === path &&
          a.payload.bytes > 0 &&
          a.completeness === "complete",
      );
      if (!a) blockers.push("Missing native submission file: " + path);
      else status.deliverables.push({ path, artifact: a.id, ...a.payload });
    }
    if (
      !native.some(
        (a) =>
          a.path.startsWith("tt_submission/") &&
          a.path.endsWith(".spef") &&
          a.payload.bytes > 0,
      )
    )
      blockers.push("Missing native parasitic extraction");
    for (const path of [
      "info.yaml",
      "LICENSE",
      "docs/info.md",
      "docs/requirements.md",
      "src/project.v",
      "src/config.json",
      "acceptance.json",
      "test/tb.sv",
    ]) {
      const file = snapshot.inputs.find((p) => p.path === path);
      if (!file?.bytes)
        blockers.push("Missing captured delivery input: " + path);
    }
    status.ready = blockers.length === 0;
    return status;
  } catch (error) {
    blockers.push(error.message);
    return status;
  }
}

export async function packageRelease(root, { run: runId }, context) {
  const status = await releaseStatus(root, runId);
  if (!status.ready)
    throw new Error("Release blocked: " + status.blockers.join("; "));
  const store = new Store(root),
    run = await verifyEvidence(store, runId),
    snapshot = await store.get(run.snapshot, "input-snapshot");
  const settingsSource = snapshot.inputs.find(
    (p) => p.path === "manufacturing.json",
  );
  const settings = await json(store.blobPath(settingsSource.sha256));
  const profile = await manufacturingProfile(settings.profile);
  const directory = join(context.workspace, "delivery");
  await mkdir(directory);
  const members = [];
  const add = async (path, payload) => {
    if (members.some((f) => f.path === path))
      throw new Error("Duplicate delivery path: " + path);
    await store.materialize([{ path, ...payload }], directory);
    members.push({ path, sha256: payload.sha256, bytes: payload.bytes });
  };
  for (const input of snapshot.inputs)
    if (
      [
        "info.yaml",
        "LICENSE",
        "flow-pins.json",
        "manufacturing.json",
        "acceptance.json",
      ].includes(input.path) ||
      /^(src|docs|test)\//.test(input.path)
    )
      await add(input.path, input);
  for (const id of run.artifacts) {
    const artifact = await store.get(id, "artifact");
    if (
      artifact.producer.task === "physical" &&
      artifact.path.startsWith("tt_submission/")
    )
      await add(artifact.path, artifact.payload);
  }
  const write = async (path, value) => {
    const target = join(directory, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, value);
    members.push({ path, ...(await fileDigest(target)) });
  };
  await write("verification-summary.json", JSON.stringify(status, null, 2));
  await write(
    "REPRODUCE.md",
    `# Reproduce this release\n\nProfile: ${profile.id}\nProfile digest: ${profile.digest}\nRun: ${run.id}\n\nInstall ChipSim and run the profile's pinned environment setup. Import the companion evidence bundle using the artifact import CLI to inspect original sources, tool identities, logs and checks. Run the captured release target in a restored project with the locked dependencies.\n\nThe archive is validated against this pinned Tiny Tapeout profile. Submission and manufacturer acceptance remain external.\n`,
  );
  const manifest = {
    format: "chipsim-manufacturing-release",
    version: 1,
    profile: profile.id,
    profileDigest: profile.digest,
    run: run.id,
    snapshot: run.snapshot,
    pins: profile.pins,
    checks: status.required,
    policy: status.comparison,
    sourceIdentity: identity(snapshot.inputs),
    members: [...members].sort((a, b) => a.path.localeCompare(b.path)),
  };
  await write("release-manifest.json", JSON.stringify(manifest, null, 2));
  await writeFile(
    join(directory, "SHA256SUMS"),
    members
      .map((m) => m.sha256 + "  " + m.path)
      .sort()
      .join("\n") + "\n",
  );
  const archive = join(context.workspace, "submission.zip");
  const script = fileURLToPath(
    new URL("../../scripts/manufacturing-archive.py", import.meta.url),
  );
  const extracted = join(context.workspace, "extracted-submission");
  const result = await execute(
    "python3",
    [script, directory, archive, extracted],
    {
      ...context,
      cwd: context.workspace,
    },
  );
  if (!result.ok)
    throw new Error("Assembled release archive failed verification");
  const support = join(context.workspace, "validation");
  await mkdir(support);
  await store.materialize(
    snapshot.inputs.filter((p) => p.path.startsWith("tt/")),
    support,
  );
  const plan = await store.get(run.plan, "execution-plan");
  const options = plan.tasks.find((t) => t.task === "physical").definition
    .options;
  const validationRequest = join(
    context.workspace,
    "archive-precheck-request.json",
  );
  await writeFile(
    validationRequest,
    JSON.stringify({
      root: context.workspace,
      options,
      support: join(support, "tt"),
      gds: join(extracted, "tt_submission", settings.metadata.top + ".gds"),
    }),
  );
  const native = await execute(
    "python3",
    [
      fileURLToPath(
        new URL("../../scripts/tinytapeout_precheck.py", import.meta.url),
      ),
      validationRequest,
    ],
    {
      ...context,
      cwd: context.workspace,
      timeoutMs: 3600000,
      env: {
        ...(await dockerEnvironment(context)),
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  if (!native.ok)
    throw new Error(
      "Extracted submission native precheck failed; inspect the package job log",
    );
  const report = await readFile(
    join(support, "tt/precheck/reports/results.xml"),
    "utf8",
  );
  const cases = parseXunit(report);
  if (!native.ok || !cases.every((c) => c.verdict === "pass"))
    throw new Error("Extracted submission archive failed native precheck");
  await writeFile(join(context.workspace, "archive-validation.xml"), report);
  // Recheck mutable source and policy after assembly; only captured bytes are
  // packaged, but a concurrent source edit must not publish a current release.
  const fresh = await releaseStatus(root, runId);
  if (
    !fresh.ready ||
    identity(fresh.comparison) !== identity(status.comparison)
  )
    throw new Error(
      "Release changed while packaging: " + fresh.blockers.join("; "),
    );
  await exportEvidence(store, runId, join(context.workspace, "evidence"));
  await writeFile(
    join(context.workspace, "release-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  const evidenceArchive = join(context.workspace, "evidence.zip");
  const evidenceResult = await execute(
    "python3",
    [
      script,
      join(context.workspace, "evidence"),
      evidenceArchive,
      "--evidence",
    ],
    { ...context, cwd: context.workspace },
  );
  if (!evidenceResult.ok)
    throw new Error("Evidence archive verification failed");
  const evidenceDigest = await fileDigest(evidenceArchive);
  const digest = await fileDigest(archive);
  await writeFile(
    join(context.workspace, "SHA256SUMS"),
    digest.sha256 +
      "  submission.zip\n" +
      evidenceDigest.sha256 +
      "  evidence.zip\n",
  );
  const final = await releaseStatus(root, runId);
  if (
    !final.ready ||
    identity(final.comparison) !== identity(status.comparison)
  )
    throw new Error(
      "Release changed before package publication: " +
        final.blockers.join("; "),
    );
  if (context.signal?.aborted) throw new Error("cancelled");
  return {
    profile: profile.id,
    sourceRun: runId,
    archive: "submission.zip",
    ...digest,
    members: members.length,
    evidence: { path: "evidence.zip", ...evidenceDigest },
  };
}
