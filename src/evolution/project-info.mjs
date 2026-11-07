// Read-only project validation and tool/runtime identities; never probe tools.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { planDesign, runtimeIdentity } from "../design/project.js";
import { Store, identity } from "../design/store.js";
import { verifyEvidence } from "../design/evidence.js";
const [mode, root, definitionFile] = process.argv.slice(2);
try {
  if (mode === "runtime") {
    process.stdout.write(JSON.stringify(await runtimeIdentity()));
  } else if (mode === "inspect-run") {
    const store = new Store(root);
    const run = await verifyEvidence(store, definitionFile);
    if (run.format !== "chipsim-run")
      throw new Error("Expected a captured run");
    const checks = await Promise.all(
      run.checks.map((id) => store.get(id, "check")),
    );
    const attempts = await Promise.all(
      run.attempts.map((id) => store.get(id, "attempt")),
    );
    const plan = await store.get(run.plan, "execution-plan");
    process.stdout.write(
      JSON.stringify({
        checks: checks.map((c) => ({
          task: c.subject.task,
          name: c.name,
          verdict: c.verdict,
          scope: c.scope || "",
          evidence: c.evidence || [],
        })),
        executions: attempts.map((a) => ({ task: a.task, ...a.execution })),
        tools: plan.tasks.flatMap((t) => t.tools),
        runtime: [
          ...new Set(plan.tasks.map((t) => identity(t.runtime))),
        ].sort(),
      }),
    );
  } else {
    const definition = JSON.parse(await readFile(definitionFile, "utf8"));
    const allowed = new Set(definition.files);
    const targets = [
      ...definition.stages,
      ...(definition.formal ? [definition.formal] : []),
    ];
    for (const stage of targets) {
      const { snapshot, plan } = await planDesign(resolve(root), stage.target, {
        capture: false,
        probe: false,
      });
      for (const input of snapshot.inputs)
        if (
          !allowed.has(input.path) &&
          !input.path.startsWith("_chipsim_resources/")
        )
          throw new Error(
            "Task input absent from benchmark files: " + input.path,
          );
      if (stage === definition.formal) {
        const proofs = plan.tasks.filter(
          (task) =>
            task.definition.adapter === "eqy" &&
            plan.policy.requiredChecks.includes(task.task + ":equivalence"),
        );
        if (
          !proofs.length ||
          !proofs.some((task) =>
            [definition.candidate, definition.formal.reference].every((path) =>
              task.inputs.some((input) => input.path === path),
            ),
          )
        )
          throw new Error(
            "Formal target must require an EQY check consuming candidate and reference inputs",
          );
      }
    }
    process.stdout.write(JSON.stringify({ valid: true }));
  }
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
}
