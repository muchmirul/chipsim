#!/usr/bin/env node
import { workbenchTools } from "../src/workbench/schema.js";
// Load native extensions through installed hosts, without sessions/providers.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2),
  hosts = [];
for (let i = 0; i < args.length; i += 2) {
  if (!["--pi", "--prime"].includes(args[i]) || !args[i + 1])
    throw new Error(
      "Usage: node scripts/test-agent-hosts.mjs --pi PACKAGE_ROOT --prime PACKAGE_ROOT",
    );
  hosts.push({ name: args[i].slice(2), root: resolve(args[i + 1]) });
}
if (!hosts.length)
  throw new Error(
    "Provide at least one installed --pi or --prime package root.",
  );
const extension = fileURLToPath(
  new URL("../extensions/chipsim.ts", import.meta.url),
);
const cwd = await mkdtemp(join(tmpdir(), "chipsim-native-hosts-"));
try {
  for (const host of hosts) {
    const { loadExtensions } = await import(
      pathToFileURL(join(host.root, "dist/core/extensions/loader.js")).href
    );
    const loaded = await loadExtensions([extension], cwd);
    assert.deepEqual(loaded.errors, [], host.name + " native load errors");
    assert.equal(loaded.extensions.length, 1);
    const native = loaded.extensions[0];
    assert.equal(native.tools.size, 37 + workbenchTools.length);
    assert.ok(native.commands.has("chipsim"));
    if (host.name === "prime" && !process.stdin.isTTY) {
      const messages = [];
      await native.commands.get("chipsim").handler("--model pio", {
        cwd,
        hasUI: true,
        ui: { notify: (message) => messages.push(message) },
      });
      assert.match(messages[0], /prime-agent daemon/);
      assert.match(messages[0], /--model.*pio/);
    }
    const call = async (name, params) => {
      const tool = native.tools.get(name).definition;
      assert.equal(tool.parameters.type, "object");
      return tool.execute(
        "offline-test",
        params,
        new AbortController().signal,
        undefined,
        { cwd },
      );
    };
    const work = await call("chipsim_work_start", {
      project: cwd,
      goal: "Native host work visibility",
    });
    assert.ok(work.details.session.id);
    const activity = await call("chipsim_snapshot", { agent: cwd });
    assert.match(activity.content[0].text, /Native host work visibility/);
    const context = (await call("chipsim_context", { target: "pio" })).details
      .programmingContext;
    assert.equal(
      (await call("chipsim_command", { args: ["agent", "context", "pio"] }))
        .details.ok,
      true,
    );
    const help = (await call("chipsim_help", {})).details;
    assert.ok(help.documentation["AGENT_CONNECTIONS.md"]);
    assert.deepEqual(context.connections, help.connections);
    for (const name of help.connections.native.workbenchTools)
      assert.ok(native.tools.has(name));
    const wb = async (name, args = {}) => {
      const reply = await call("chipsim_workbench_" + name, {
        project: cwd,
        ...args,
      });
      assert.equal(reply.details.ok, true, JSON.stringify(reply.details));
      return reply.details.result;
    };
    await wb("project");
    const sources = {
      "contract.json": {
        format: "chipsim-program-contract",
        version: 1,
        wordWidth: 8,
        depth: 1,
        resources: {},
        instructions: {
          add: { opcode: 1, operandBits: 4, cycles: 1, resources: {} },
        },
      },
      "program.json": {
        format: "chipsim-program",
        version: 1,
        instructions: [{ op: "add", value: 1, cycle: 0 }],
      },
      "chipsim.design.json": {
        format: "chipsim-design",
        version: 1,
        id: "native-host",
        tasks: {
          image: {
            adapter: "program-image",
            options: { contract: "contract.json", program: "program.json" },
            outputs: [{ path: "out/program.hex", kind: "memory-image" }],
          },
        },
        targets: {
          image: {
            tasks: ["image"],
            requiredChecks: ["image:program-validation", "image:outputs"],
          },
        },
      },
      "chipsim.lock.json": {
        format: "chipsim-lock",
        version: 1,
        dependencies: [],
      },
      "netlist.json": {
        modules: { top: { ports: { q: { direction: "output", bits: [2] } } } },
      },
    };
    for (const [path, value] of Object.entries(sources)) {
      const previous = await call("chipsim_workbench_file_read", {
        project: cwd,
        path,
      });
      await wb("file_write", {
        path,
        text: JSON.stringify(value),
        expectedHash: previous.details.ok
          ? previous.details.result.sha256
          : null,
      });
    }
    const job = await wb("job_start", {
      target: "image",
      requestId: host.name + "-image",
    });
    let done;
    for (let i = 0; i < 60; i++) {
      done = await wb("job_status", { job: job.id, waitMs: 1000 });
      if (
        ["completed", "failed", "cancelled", "interrupted"].includes(done.state)
      )
        break;
    }
    assert.equal(done.state, "completed", JSON.stringify(done));
    assert.equal((await wb("checks", { target: "image" })).ready, true);
    const netlist = await call("chipsim_snapshot", {
      netlist: join(cwd, "netlist.json"),
    });
    assert.match(netlist.content[0].text, /synthesized netlist/);
    assert.equal(netlist.details.view, "schematic");
    assert.match(
      (await call("chipsim_snapshot", { model: "pio" })).content[0].text,
      /CHIPSIM/,
    );
    // Source-free host acceptance is always available. Private program citations
    // remain a separate gate; never synthesize substitute vendor evidence.
    const privatePrograms = context.documents.every(
      (document) => document.available,
    );
    if (privatePrograms) {
      const program = context.examples.find(
        (entry) => entry.modelId === "pio",
      ).path;
      assert.equal(
        (await call("chipsim_program_check", { model: "pio", program })).details
          .ok,
        true,
      );
      const run = (
        await call("chipsim_program_run", {
          model: "pio",
          program,
          out: host.name + " run",
        })
      ).details;
      const trace = JSON.parse(
        await readFile(run.artifacts["trace.json"], "utf8"),
      );
      assert.equal(trace.trace.at(-1).registers.decoded, 179);
      assert.match(
        (
          await call("chipsim_snapshot", {
            model: run.artifacts["session.json"],
            view: "states",
          })
        ).content[0].text,
        /CHIPSIM/,
      );
    }
    console.log(
      `${host.name}: registered ${native.tools.size} tools and /chipsim; discovery, native workbench image job/checks and netlist snapshots passed. Private-source program acceptance: ${privatePrograms ? "passed" : "skipped (original references unavailable)"}.`,
    );
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
