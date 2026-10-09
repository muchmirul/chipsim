import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  packageRoot,
  prepareProject,
  searchProject,
  readPage,
  loadProject,
} from "./project.js";
import { checkModel, runModel } from "./model.js";
import { loadAgentProgram, runAgentProgram } from "./program.js";
import { programmingContext } from "./context.js";
import { AgentError, integer, readBounded } from "./io.js";
import { recordActivity, readActivity, digest } from "./activity.js";
import metadata from "../../package.json" with { type: "json" };

const commands = {
  help: { positionals: [], options: {} },
  doctor: { positionals: [], options: {} },
  context: {
    positionals: ["chip-or-project"],
    options: { project: "optional", model: "optional" },
  },
  note: { positionals: ["project", "message"], options: {} },
  activity: { positionals: ["project"], options: { limit: "optional" } },
  "program-check": {
    positionals: ["program.chip"],
    options: { model: "required", project: "optional" },
  },
  "program-run": {
    positionals: ["program.chip"],
    options: {
      model: "required",
      project: "optional",
      out: "required",
      ticks: "optional",
      steps: "optional",
    },
  },
  prepare: { positionals: ["manual.pdf"], options: { out: "required" } },
  search: {
    positionals: ["project", "query"],
    options: { offset: "optional", limit: "optional" },
  },
  page: {
    positionals: ["project", "pdf-page"],
    options: { offset: "optional", limit: "optional" },
  },
  check: { positionals: ["model.json"], options: { project: "required" } },
  run: {
    positionals: ["model.json"],
    options: {
      project: "required",
      out: "required",
      params: "optional",
      inputs: "optional",
      ticks: "optional",
    },
  },
};

function parse(args) {
  const command = args[0] || "help";
  if (
    ["--help", "-h"].includes(command) ||
    (args.length === 2 && ["--help", "-h"].includes(args[1]))
  )
    return { command: "help", positional: [], options: {} };
  const schema = commands[command];
  if (!schema)
    throw new AgentError(
      "ARGUMENT",
      `Unknown agent command: ${command}. Use chipsim agent help.`,
      [],
      2,
    );
  const positional = [],
    options = {};
  let literal = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--" && !literal) {
      literal = true;
      continue;
    }
    if (arg.startsWith("-") && !literal) {
      const key = arg.slice(2);
      if (!arg.startsWith("--") || !Object.hasOwn(schema.options, key))
        throw new AgentError("ARGUMENT", `Unknown option: ${arg}`, [], 2);
      if (Object.hasOwn(options, key))
        throw new AgentError("ARGUMENT", `Duplicate option: ${arg}`, [], 2);
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new AgentError("ARGUMENT", `Missing value: ${arg}`, [], 2);
      options[key] = args[++i];
    } else positional.push(arg);
  }
  if (positional.length !== schema.positionals.length)
    throw new AgentError(
      "ARGUMENT",
      `${command} expects ${schema.positionals.join(" ") || "no positional arguments"}`,
      [],
      2,
    );
  for (const [key, requirement] of Object.entries(schema.options))
    if (requirement === "required" && !options[key])
      throw new AgentError("ARGUMENT", `Missing required --${key}`, [], 2);
  return { command, positional, options };
}

async function doctor() {
  const results = await Promise.all(
    ["pdfinfo", "pdftotext"].map(async (command) => {
      try {
        const result = await promisify(execFile)(command, ["-v"], {
          timeout: 5000,
          maxBuffer: 65536,
        });
        return {
          command,
          available: true,
          version: (result.stderr || result.stdout).split("\n")[0],
        };
      } catch {
        return { command, available: false };
      }
    }),
  );
  return {
    ok: results.every((result) => result.available),
    toolVersion: metadata.version,
    node: process.versions.node,
    platform: process.platform,
    pdfTools: results,
    diagnostics: results
      .filter((result) => !result.available)
      .map((result) => ({
        code: "DEPENDENCY",
        message: `Install Poppler: missing ${result.command}`,
      })),
  };
}

export async function agentCommand(args) {
  const envelope = {
    format: "chipsim-agent-result",
    version: 1,
    command: args[0] || "help",
  };
  let context;
  let sequence = 0;
  const requestId = randomUUID();
  const activityWarnings = [];
  const emit = async (status, message, details = {}) => {
    if (!context) return;
    try {
      await recordActivity(context.project, {
        requestId,
        sequence: sequence++,
        command: context.command,
        status,
        message: message.slice(0, 2000),
        details,
      });
    } catch (error) {
      if (!activityWarnings.length)
        activityWarnings.push(
          "Activity could not be recorded: " + error.message,
        );
    }
  };
  try {
    const { command, positional, options } = parse(args);
    envelope.command = command;
    if (
      [
        "prepare",
        "search",
        "page",
        "check",
        "run",
        "program-check",
        "program-run",
      ].includes(command) &&
      (!command.startsWith("program-") || options.project)
    ) {
      context = {
        command,
        project:
          command === "prepare"
            ? options.out
            : options.project || positional[0],
      };
      if (command !== "prepare")
        await emit("started", `${command} started`, {
          ...(command === "search" ? { query: positional[1] } : {}),
          ...(command === "page" ? { page: positional[1] } : {}),
          ...(["check", "run"].includes(command)
            ? { modelFile: resolve(positional[0]) }
            : {}),
        });
    }
    let result;
    if (command === "help")
      result = {
        tool: "chipsim",
        toolVersion: metadata.version,
        commands,
        documentation: Object.fromEntries(
          [
            "AGENT_WORKFLOW.md",
            "MODEL_FORMAT.md",
            "PROGRAMMING.md",
            "EXISTING_SIMULATORS.md",
          ].map((name) => [name, join(packageRoot, "docs", name)]),
        ),
        protocol: {
          stdout: "One JSON result; no ANSI, prompts, or progress text",
          exitCodes: {
            0: "success",
            1: "validation, dependency, file or simulation failure",
            2: "invalid arguments",
          },
        },
        notes: [
          "No embedded model provider; author models with your existing coding agent.",
          "Before programming: chipsim agent context CHIP_ID or PROJECT. Select a model, review capabilities and guides, then choose supported experiment or a separate native backend.",
          "PDF pages are one-based, including front matter. Each project contains one manual.",
          "prepare and run require new output directories; existing files are never replaced.",
        ],
      };
    else if (command === "doctor") result = await doctor();
    else if (command === "context") {
      const programming = await programmingContext(positional[0], options);
      if (programming.project)
        context = { command, project: programming.project };
      result = { programmingContext: programming };
    } else if (command === "program-check") {
      const { debug } = await loadAgentProgram(positional[0], options);
      result = {
        ...debug.report(),
        instructions: debug.program.instructions.length,
        sourcesVerified: true,
        programmingContextCommand: [
          "chipsim",
          "agent",
          "context",
          options.project || options.model,
          ...(options.project ? ["--model", options.model] : []),
        ],
      };
    } else if (command === "program-run")
      result = await runAgentProgram(positional[0], options.out, {
        ...options,
        progress: (message) => emit("progress", message),
        ticks:
          options.ticks === undefined
            ? undefined
            : integer(options.ticks, "ticks", 1, 10000),
        steps:
          options.steps === undefined
            ? undefined
            : integer(options.steps, "steps", 1, 10000),
      });
    else if (command === "note") {
      if (!positional[1].trim() || positional[1].length > 2000)
        throw new AgentError(
          "ARGUMENT",
          "Activity note must contain 1–2000 characters",
          [],
          2,
        );
      result = {
        event: await recordActivity(positional[0], {
          command: "note",
          status: "note",
          message: positional[1],
          requestId,
          sequence: 0,
        }),
      };
    } else if (command === "activity") {
      await loadProject(positional[0]);
      const limit = integer(options.limit ?? 50, "limit", 1, 200);
      const events = await readActivity(positional[0]);
      result = {
        project: resolve(positional[0]),
        total: events.length,
        events: events.slice(-limit),
      };
    } else if (command === "prepare")
      result = await prepareProject(positional[0], options.out);
    else if (command === "check")
      result = (
        await checkModel(positional[0], options.project, {
          progress: (message) => emit("progress", message),
        })
      ).report;
    else if (command === "run")
      result = await runModel(positional[0], options.project, options.out, {
        ...options,
        progress: (message) => emit("progress", message),
        ticks:
          options.ticks === undefined
            ? undefined
            : integer(options.ticks, "ticks", 1, 10000),
      });
    else {
      const paging = {
        offset: integer(options.offset ?? 0, "offset", 0, 128 * 1048576),
        limit: integer(
          options.limit ?? (command === "search" ? 10 : 8000),
          "limit",
          1,
          command === "search" ? 50 : 16000,
        ),
      };
      result =
        command === "search"
          ? await searchProject(positional[0], positional[1], paging)
          : await readPage(
              positional[0],
              integer(positional[1], "page", 1, 20000),
              paging,
            );
    }
    if (context) {
      const details = {};
      let message = `${command} completed`;
      if (command === "context")
        message = `Programming context · ${result.programmingContext.models.length} models · ${result.programmingContext.chips.map((chip) => chip.name).join(", ") || "unidentified manual"}`;
      if (command === "prepare")
        message = `Project prepared · ${result.source.pages} PDF pages · ${result.models.length} models`;
      if (command === "search") {
        details.pages = result.matches.map((match) => match.page);
        message = `Search "${result.query}" · ${result.total} matches · returned PDF pages ${details.pages.join(", ") || "none"}`;
      }
      if (command === "page")
        message = `Read PDF page ${result.page} · characters ${result.offset}–${result.offset + result.text.length}`;
      if (["check", "run"].includes(command)) {
        details.modelFile = resolve(positional[0]);
        details.modelId = result.model?.id;
        details.passed =
          result.checks?.filter((check) => check.passed).length || 0;
        details.total = result.checks?.length || 0;
        details.failedChecks = (result.checks || [])
          .filter((check) => !check.passed)
          .slice(0, 10)
          .map((check) => ({
            name: check.name,
            error: String(check.error || "failed").slice(0, 200),
          }));
        message = `${command} ${result.model?.id || "model"} · ${details.passed}/${details.total} checks passed`;
      }
      if (result.artifacts) {
        details.resultFile = join(resolve(options.out), "result.json");
        details.sessionFile = result.artifacts["session.json"];
        try {
          details.resultSha256 = digest(
            await readBounded(details.resultFile, 3 * 1048576),
          );
          details.sessionSha256 = digest(
            await readBounded(details.sessionFile, 3 * 1048576),
          );
        } catch (error) {
          activityWarnings.push(
            "Run could not be published for watching: " + error.message,
          );
          delete details.resultFile;
          delete details.sessionFile;
        }
        message += ` · ${result.snapshots} snapshots · ${result.ok ? "run ready" : "simulation fault"}`;
      }
      if (result.ok === false) details.diagnostics = result.diagnostics;
      await emit(
        result.ok === false ? "failed" : "succeeded",
        message,
        details,
      );
    }
    return {
      result: {
        ok: true,
        ...result,
        ...envelope,
        ...(activityWarnings.length ? { activityWarnings } : {}),
      },
      exitCode: result.ok === false ? 1 : 0,
    };
  } catch (error) {
    if (context?.command !== "prepare")
      await emit(
        "failed",
        `${context?.command || "command"} failed: ${error.message}`,
      );
    return {
      result: {
        ...envelope,
        ok: false,
        diagnostics: [
          {
            code:
              error.name === "ModelError"
                ? "MODEL_INVALID"
                : error.code || "ERROR",
            message: error.message,
            details: error.errors || error.details || [],
          },
        ],
        ...(activityWarnings.length ? { activityWarnings } : {}),
      },
      exitCode: error.exitCode || 1,
    };
  }
}
