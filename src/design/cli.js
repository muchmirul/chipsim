import {
  loadDesign,
  initDesign,
  planDesign,
  dependencyIdentity,
} from "./project.js";
import { resolve } from "node:path";
import {
  startJob,
  jobStatus,
  listJobs,
  cancelJob,
  retryJob,
  waitJob,
  jobLogs,
} from "./jobs.js";
import {
  inspectArtifact,
  verifyEvidence,
  importEvidence,
  exportEvidence,
} from "./evidence.js";
import { checksForTarget, compareRuns, targetStatus } from "./service.js";
import { designCommands, parseCommand } from "./commands.js";
import { integrationContracts } from "./contracts.js";
import { designGuide, designGuidance } from "./guide.js";

export const usage = `Versioned design workbench
chipsim design commands
chipsim design guide [rtl|testbench|waveform|firmware|registers|formal|physical|model]
chipsim design init PROJECT
chipsim design status --project PROJECT [--target TARGET]
chipsim design lock --project PROJECT --path DEPENDENCY_DIRECTORY
chipsim design doctor|plan|run --project PROJECT [--target TARGET] [--wait --timeout-ms N] [--no-reuse]
chipsim job status|logs|cancel|retry ID --project PROJECT [--wait --timeout-ms N] [--offset N --limit N]
chipsim artifact list --project PROJECT [--offset N --limit N]
chipsim artifact inspect|verify ID --project PROJECT [--offset N --limit N]
chipsim artifact import DIRECTORY --project PROJECT
chipsim artifact export ID --project PROJECT --out NEW_DIRECTORY
chipsim artifact compare LEFT_RUN RIGHT_RUN --project PROJECT
chipsim checks --project PROJECT [--target TARGET] [--run RUN_ID]
chipsim --design PROJECT [--view project|pipeline|artifacts|checks]
See docs/DESIGN.md. Starting a job is explicit execution; closing a waiting command never cancels it.`;
export async function designCommand(args) {
  const [family, ...rest] = args;
  const envelope = {
    format: "chipsim-design-result",
    version: 1,
    command: args.slice(0, 2).join(" "),
  };
  let parsed = false;
  try {
    if (rest.includes("--help") || rest[0] === "help")
      return { result: { ...envelope, ok: true, help: usage }, exitCode: 0 };
    const { options: o, positional: p, command } = parseCommand(args);
    envelope.command = [family, command].filter(Boolean).join(" ");
    parsed = true;
    if (family === "design" && command === "commands")
      return {
        result: {
          ...envelope,
          ok: true,
          commands: designCommands,
          integrations: integrationContracts,
          guidance: designGuidance(),
          resultContract: { format: "chipsim-design-result", version: 1 },
          wait: {
            defaultTimeoutMs: 86400000,
            boundedTimeoutMs: [1, 60000],
            cancelsJob: false,
          },
        },
        exitCode: 0,
      };
    if (family === "design" && command === "guide")
      return {
        result: { ...envelope, ok: true, guide: designGuide(p[0]) },
        exitCode: 0,
      };
    if (family === "design" && command === "init")
      return {
        result: { ...envelope, ok: true, ...(await initDesign(p[0])) },
        exitCode: 0,
      };
    const { store, config, root } = await loadDesign(o.project);
    const target = o.target || Object.keys(config.targets)[0];
    let result;
    if (family === "design") {
      if (command === "status") {
        result = await targetStatus(o.project, target);
      } else if (command === "lock") {
        if (!o.path) throw new Error("lock requires --path DIRECTORY");
        const path = resolve(root, o.path);
        result = {
          dependency: { path, sha256: await dependencyIdentity(path) },
        };
      } else if (["doctor", "plan"].includes(command)) {
        const { plan, snapshot } = await planDesign(o.project, target, {
          capture: command === "plan",
        });
        result =
          command === "plan"
            ? {
                plan: {
                  id: plan.id,
                  target: plan.target,
                  policy: plan.policy,
                  tasks: plan.tasks.map((t) => ({
                    task: t.task,
                    adapter: t.definition.adapter,
                    fingerprint: t.fingerprint,
                    needs: t.needs,
                    inputs: t.inputs.length,
                    tools: t.tools,
                  })),
                },
                snapshot: snapshot.id,
              }
            : {
                capabilities: plan.tasks.map((t) => ({
                  task: t.task,
                  adapter: t.definition.adapter,
                  tools: t.tools,
                  available: t.tools.every((t) => t.available),
                })),
                ok: plan.tasks.every((t) => t.tools.every((t) => t.available)),
              };
      } else if (command === "run") {
        const job = await startJob(o.project, target, {
          reuse: !o["no-reuse"],
        });
        result = {
          accepted: true,
          job: o.wait
            ? await waitJob(store, job.id, { timeoutMs: o["timeout-ms"] })
            : job,
        };
        if (o.wait && !result.job.waitingStopped)
          result.ok = result.job.state === "completed" && result.job.ready;
      } else throw new Error("Unknown design command");
    } else if (family === "job") {
      if (command === "status" && p.length === 0) {
        result = { jobs: await listJobs(store) };
      } else {
        if (command === "status")
          result = {
            job: o.wait
              ? await waitJob(store, p[0], { timeoutMs: o["timeout-ms"] })
              : await jobStatus(store, p[0]),
          };
        else if (command === "logs") result = await jobLogs(store, p[0], o);
        else if (command === "cancel")
          result = { job: await cancelJob(store, p[0]) };
        else if (command === "retry") {
          const job = await retryJob(store, p[0]);
          result = {
            accepted: true,
            job: o.wait
              ? await waitJob(store, job.id, { timeoutMs: o["timeout-ms"] })
              : job,
          };
        } else throw new Error("Unknown job command");
      }
    } else if (family === "artifact") {
      if (command === "list") {
        const all = await store.list("artifact"),
          offset = o.offset || 0,
          limit = Math.min(o.limit || 50, 200);
        result = {
          artifacts: all
            .slice(offset, offset + limit)
            .map(({ inputs, ...a }) => ({ ...a, inputCount: inputs.length })),
          total: all.length,
          nextOffset: offset + limit < all.length ? offset + limit : null,
        };
      } else if (command === "inspect") {
        result = await inspectArtifact(store, p[0], o);
      } else if (command === "verify") {
        await verifyEvidence(store, p[0]);
        result = { id: p[0], verified: true };
      } else if (command === "import") {
        result = await importEvidence(store, p[0]);
      } else if (command === "export") {
        if (!o.out) throw new Error("Export requires --out NEW_DIRECTORY");
        result = await exportEvidence(store, p[0], o.out);
      } else if (command === "compare") {
        result = await compareRuns(store, ...p);
      } else throw new Error("Unknown artifact command");
    } else if (family === "checks") {
      result = await checksForTarget(o.project, target, o.run);
      result.ok = result.ready;
    } else throw new Error("Unknown design command family");
    return {
      result: { ...envelope, ok: true, ...result },
      exitCode: result.ok === false ? 1 : 0,
    };
  } catch (error) {
    const exitCode = error.exitCode || (parsed ? 1 : 2);
    return {
      result: {
        ...envelope,
        ok: false,
        diagnostics: [
          {
            code: exitCode === 2 ? "ARGUMENT" : "DESIGN",
            message: error.message,
          },
        ],
      },
      exitCode,
    };
  }
}
export async function main(args) {
  const { result, exitCode } = await designCommand(args);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = exitCode;
  return result;
}
