import { fileURLToPath } from "node:url";
import { workbenchTools } from "../workbench/schema.js";

const installed = (path) =>
  fileURLToPath(new URL("../../" + path, import.meta.url));

// Keep installed help, generated context, prepared projects and MCP resources
// on the same documentation inventory. Discovery does not probe or configure hosts.
export const agentDocumentation = [
  "AGENT_CONNECTIONS.md",
  "AGENT_CONTROL.md",
  "AGENT_WORKFLOW.md",
  "AGENT_QUICKSTART.md",
  "AGENT_EXTENSIONS.md",
  "WORKBENCH_MCP.md",
  "TINYTAPEOUT.md",
  "AGENT_WORK.md",
  "EVOLUTION.md",
  "EVOLUTION_OBJECTIVES.md",
  "CONNECTED_CIRCUITS.md",
  "AGENT_CIRCUITS.md",
  "CHANGELOG.md",
  "TUI.md",
  "VISUALIZATION.md",
  "DEVELOPMENT.md",
  "PROGRAMMING.md",
  "EXISTING_SIMULATORS.md",
  "HDL.md",
  "HDL_DEBUG.md",
  "HDL_ENVIRONMENT.md",
  "DESIGN.md",
  "DESIGN_INPUTS.md",
  "LOCAL_REFERENCES.md",
  "LICENSING.md",
  "CSV_INPUTS.md",
  "MODEL_FORMAT.md",
  "FUNCTION_TABLES.md",
  "REGISTER_BANKS.md",
  "BEHAVIOR_TABLES.md",
  "DOCUMENT_PROFILES.md",
  "ESP32_C6_GPIO.md",
  "ESP32_C6_PCNT.md",
  "REFERENCES.md",
];
export const documentationPaths = () =>
  Object.fromEntries(
    agentDocumentation.map((name) => [name, installed("docs/" + name)]),
  );
export function agentConnections() {
  return {
    availability:
      "Discovery only; does not probe installed hosts/tools, install dependencies or configure clients.",
    guide: installed("docs/AGENT_CONNECTIONS.md"),
    cli: {
      script: installed("scripts/chipsim.mjs"),
      discovery: [
        ["agent", "help"],
        ["workbench", "tools"],
        ["design", "commands"],
      ],
      project: ["workbench", "project", "--project", "PROJECT"],
      modelContext: ["agent", "context", "CHIP_OR_PREPARED_PROJECT"],
      argumentConvention:
        "Arrays omit the executable; replace uppercase placeholders and keep each path as one literal argument.",
    },
    native: {
      extension: installed("extensions/chipsim.ts"),
      generalTool: "chipsim_command",
      workbenchTools: workbenchTools.map(
        (tool) => "chipsim_workbench_" + tool.name,
      ),
      snapshotTool: "chipsim_snapshot",
      snapshotSources: [
        "model",
        "waveform",
        "hdlDebug",
        "circuit",
        "netlist",
        "design",
        "agent",
      ],
      project:
        "Pass an explicit project on each workbench call; relative paths use that call's cwd.",
    },
    mcp: {
      command: "chipsim",
      args: ["mcp", "--project", "PROJECT"],
      dependencyInstall: {
        command: "npm",
        args: ["ci", "--prefix", installed("extensions/mcp")],
      },
      transport:
        "stdio; one existing project directory per server; stdout is protocol-only",
      tools: workbenchTools.map((tool) => "chipsim_" + tool.name),
      resources: {
        connections: "chipsim://guide/connections",
        workflow: "chipsim://guide/workbench",
        schemas: "chipsim://schema/tools",
        project: "chipsim://project/status",
      },
      scope:
        "The workbench tool family; other CLI families are not implicitly exposed as MCP tools. Accepted jobs survive disconnect; cancel explicitly.",
    },
  };
}
