import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  packageRoot,
  prepareProject,
  searchProject,
  readPage,
} from "./project.js";
import { checkModel, runModel } from "./model.js";
import { AgentError, integer } from "./io.js";
import metadata from "../../package.json" with { type: "json" };

const commands = {
  help: { positionals: [], options: {} },
  doctor: { positionals: [], options: {} },
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
  try {
    const { command, positional, options } = parse(args);
    envelope.command = command;
    let result;
    if (command === "help")
      result = {
        tool: "chipsim",
        toolVersion: metadata.version,
        commands,
        documentation: Object.fromEntries(
          ["AGENT_WORKFLOW.md", "MODEL_FORMAT.md"].map((name) => [
            name,
            join(packageRoot, "docs", name),
          ]),
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
          "PDF pages are one-based, including front matter. Each project contains one manual.",
          "prepare and run require new output directories; existing files are never replaced.",
        ],
      };
    else if (command === "doctor") result = await doctor();
    else if (command === "prepare")
      result = await prepareProject(positional[0], options.out);
    else if (command === "check")
      result = (await checkModel(positional[0], options.project)).report;
    else if (command === "run")
      result = await runModel(positional[0], options.project, options.out, {
        ...options,
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
    return {
      result: { ...envelope, ok: true, ...result },
      exitCode: result.ok === false ? 1 : 0,
    };
  } catch (error) {
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
      },
      exitCode: error.exitCode || 1,
    };
  }
}
