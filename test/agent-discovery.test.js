import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentCommand } from "../src/agent/commands.js";
import {
  agentDocumentation,
  agentConnections,
} from "../src/agent/discovery.js";
import { prepareProject } from "../src/agent/project.js";
import {
  buildProgrammingContext,
  programmingContextMarkdown,
} from "../src/agent/context.js";
import {
  createWorkbench,
  workbenchResources,
} from "../src/workbench/service.js";
import { workbenchTools } from "../src/workbench/schema.js";
import { designGuide } from "../src/design/guide.js";
import { integrationContracts } from "../src/design/contracts.js";
import { runChipSim } from "../src/integrations/process.js";

const packageRoot = new URL("../", import.meta.url).pathname;
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), "chipsim-agent-discovery-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("installed help, model context and MCP resources share every current topic guide without executing tools", async (t) => {
  const root = await temporary(t),
    wb = await createWorkbench(root);
  const help = (await agentCommand(["help"])).result;
  const context = buildProgrammingContext({ chips: [], models: [] });
  const topics = (await readdir(join(packageRoot, "docs"))).filter(
    (name) => name.endsWith(".md") && name !== "AGENT_PROJECT.md",
  );
  assert.deepEqual([...agentDocumentation].sort(), topics.sort());
  assert.deepEqual(context.documentation, help.documentation);
  assert.deepEqual(context.connections, help.connections);
  assert.deepEqual(help.connections, agentConnections());
  for (const name of agentDocumentation) {
    assert.equal(help.documentation[name], join(packageRoot, "docs", name));
    const resource = workbenchResources.find(
      (r) => r.uri === "chipsim://docs/" + name,
    );
    assert.ok(resource, name);
    assert.equal(
      (await wb.resource(resource.uri)).text,
      await readFile(help.documentation[name], "utf8"),
    );
  }
  await assert.rejects(() => wb.resource("chipsim://docs/../package.json"));
  await assert.rejects(() => wb.resource("chipsim://docs/NOT_INSTALLED.md"));
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(
    help.connections.mcp.tools,
    workbenchTools.map((t) => "chipsim_" + t.name),
  );
  assert.deepEqual(
    help.connections.native.workbenchTools,
    workbenchTools.map((t) => "chipsim_workbench_" + t.name),
  );
  for (const guide of [
    "AGENT_CONNECTIONS.md",
    "AGENT_EXTENSIONS.md",
    "WORKBENCH_MCP.md",
    "TINYTAPEOUT.md",
  ])
    assert.ok(
      programmingContextMarkdown(context).includes(help.documentation[guide]),
    );
  assert.equal(context.decision.nativeExecution.available, false);
  assert.ok((await stat(help.examples.programmable.guide)).isFile());
  assert.equal(
    designGuide("programmable").recipe.example,
    help.examples.programmable.directory,
  );
  assert.deepEqual(designGuide("tinytapeout").recipe.adapters, ["tinytapeout"]);
  assert.ok(
    integrationContracts
      .find((contract) => contract.adapter === "tinytapeout")
      .checks.includes("physical-metrics"),
  );
  for (const topic of ["programmable", "tinytapeout"])
    assert.ok(
      JSON.parse(
        (await wb.resource("chipsim://guide/recipes?topic=" + topic)).text,
      ).recipe.minimumInputs.length,
    );
});

test("new prepared projects copy the complete current guide inventory and generate connection context", async (t) => {
  const root = await temporary(t),
    manual = join(root, "manual.pdf");
  // Original one-page source fixture; no publisher references or network access.
  const stream =
    "BT /F1 12 Tf 40 700 Td (An original agent discovery test manual.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const position = Buffer.byteLength(pdf);
  pdf +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets
      .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
      .join("");
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  await writeFile(manual, pdf);
  const project = join(root, "prepared");
  await prepareProject(manual, project);
  assert.deepEqual(
    (await readdir(join(project, "docs"))).sort(),
    [...agentDocumentation].sort(),
  );
  for (const name of agentDocumentation)
    assert.equal(
      await readFile(join(project, "docs", name), "utf8"),
      await readFile(join(packageRoot, "docs", name), "utf8"),
    );
  const context = JSON.parse(
    await readFile(join(project, "programming-context.json"), "utf8"),
  );
  assert.deepEqual(context.connections, agentConnections());
  assert.match(
    await readFile(join(project, "AGENTS.md"), "utf8"),
    /AGENT_CONNECTIONS.md/,
  );
  assert.match(
    await readFile(join(project, "PROGRAMMING_CONTEXT.md"), "utf8"),
    /WORKBENCH_MCP.md/,
  );
});

test("workbench stdin transport preserves JSON results, bounds and early startup diagnostics", async (t) => {
  const cwd = await temporary(t);
  const args = ["workbench", "project", "--project", cwd, "--input", "-"];
  const result = await runChipSim(args, { cwd, input: "{}" });
  assert.equal(result.ok, true);
  assert.equal(result.result.root, cwd);
  await assert.rejects(
    () => runChipSim(args, { cwd, input: "{ invalid" }),
    (error) => {
      assert.ok(error.details.stderr.includes("JSON"));
      return true;
    },
  );
  await assert.rejects(
    () => runChipSim(args, { cwd, input: "x".repeat(8 * 1048576 + 1) }),
    /at most 8 MiB/,
  );
  // The child can fail before reading a large pipe; EPIPE must not hide its error.
  await assert.rejects(
    () =>
      runChipSim(
        [
          "workbench",
          "project",
          "--project",
          join(cwd, "missing"),
          "--input",
          "-",
        ],
        { cwd, input: " ".repeat(1048576) },
      ),
    (error) => {
      assert.match(error.details.stderr, /ENOENT/);
      return true;
    },
  );
});
