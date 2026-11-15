import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { startCapturedJob } from "../design/jobs.js";
import { runtimeIdentity, toolIdentity } from "../design/project.js";
import { Store, identity } from "../design/store.js";

// Service operations create ordinary immutable plans. No alternate worker or
// polling/cancellation protocol is introduced for pre-manifest setup jobs.
export function serviceJob(root, operation, request, requestId) {
  return startCapturedJob(root, "manufacturing-" + operation, {
    requestId,
    reuse: false,
    requestKey: identity({ operation, request }),
    prepare: async () => {
      const store = new Store(root),
        runtime = await runtimeIdentity();
      const definition = {
        adapter: "@manufacturing",
        options: { operation, request },
        outputs: [{ path: "result.json", kind: "manufacturing-report" }],
      };
      const config = {
        id: "manufacturing-service",
        tasks: { service: definition },
      };
      const snapshot = await store.put("input-snapshot", {
        config,
        lock: {},
        inputs: [],
        runtime,
      });
      const base = {
        task: "service",
        definition,
        profile: {},
        inputs: [],
        tools: await Promise.all([
          toolIdentity("python3", ["--version"]),
          toolIdentity("docker", ["--version"]),
        ]),
        dependencies: [],
        runtime,
      };
      const plan = await store.put("execution-plan", {
        projectId: config.id,
        target: "manufacturing-" + operation,
        snapshot: snapshot.id,
        policy: {
          tasks: ["service"],
          requiredChecks: ["service:execution", "service:outputs"],
        },
        tasks: [{ ...base, fingerprint: identity(base), needs: [] }],
      });
      return { root, store, snapshot, plan };
    },
  });
}

export async function executeManufacturing(task, context) {
  const { operation, request } = task.definition.options;
  let result;
  if (operation === "setup") {
    const { setupEnvironment } = await import("./environment.js");
    result = await setupEnvironment(request, context);
  } else if (operation === "package") {
    const { packageRelease } = await import("./release.js");
    result = await packageRelease(context.projectRoot, request, context);
  } else throw new Error("Unknown manufacturing operation");
  if (context.signal?.aborted) throw new Error("cancelled");
  await mkdir(context.workspace, { recursive: true });
  await writeFile(
    join(context.workspace, "result.json"),
    JSON.stringify(result, null, 2),
  );
  return { ok: true };
}
