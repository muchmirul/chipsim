import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const enabled = process.env.CHIPSIM_TEST_MCP === "1";
const cli = new URL("../scripts/chipsim.mjs", import.meta.url).pathname;
async function connect(root, t) {
  const { Client } =
    await import("../extensions/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
  const { StdioClientTransport } =
    await import("../extensions/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--project", root],
    stderr: "pipe",
    env: { ...process.env },
  });
  const client = new Client(
    { name: "chipsim-acceptance", version: "1.0.0" },
    { capabilities: {} },
  );
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  await client.connect(transport);
  t.after(() => client.close());
  const raw = async (name, args = {}) =>
    (await client.callTool({ name: "chipsim_" + name, arguments: args }))
      .structuredContent;
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    assert.equal(result?.ok, true, JSON.stringify(result) + "\n" + stderr);
    return result.result;
  };
  return { client, raw, call };
}
async function finish(call, id) {
  for (let i = 0; i < 60; i++) {
    const job = await call("job_status", { job: id, waitMs: 1000 });
    if (["completed", "failed", "cancelled", "interrupted"].includes(job.state))
      return job;
  }
  throw new Error("Job did not finish");
}

test(
  "official SDK: MCP-only create, failure inspection, repair, immutable retry, two programs and native synthesis",
  { skip: !enabled, timeout: 180000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-mcp-hdl-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { call, raw, client } = await connect(root, t);
    assert.match(
      (await call("resource_read", { uri: "chipsim://guide/connections" }))
        .text,
      /Connect an agent/,
    );
    assert.equal(
      (await raw("resource_read", { uri: "file:///etc/passwd" })).ok,
      false,
    );
    const listed = await client.listTools();
    assert.ok(listed.tools.length >= 20);
    assert.ok(listed.tools.every((t) => t.inputSchema && t.outputSchema));
    assert.match(
      (await client.readResource({ uri: "chipsim://guide/workbench" }))
        .contents[0].text,
      /Agent loop/,
    );
    const resources = (await client.listResources()).resources.filter((r) =>
      r.uri.startsWith("chipsim://examples/programmable/"),
    );
    assert.equal(resources.length, 10);
    assert.ok(resources.some((r) => r.name.endsWith("README.md")));
    for (const resource of (await client.listResources()).resources.filter(
      (r) => r.uri.startsWith("chipsim://docs/"),
    ))
      assert.ok(
        (await client.readResource({ uri: resource.uri })).contents[0].text
          .length > 100,
      );
    assert.match(
      (await client.readResource({ uri: "chipsim://guide/connections" }))
        .contents[0].text,
      /Connect an agent/,
    );
    for (const resource of resources)
      await call("file_write", {
        path: resource.uri.split("/").at(-1),
        text: (await client.readResource({ uri: resource.uri })).contents[0]
          .text,
        expectedHash: null,
      });
    const hardware = await call("file_read", { path: "engine.sv" });
    const broken = await call("file_write", {
      path: "engine.sv",
      text: hardware.text.replace("value + instruction", "value - instruction"),
      expectedHash: hardware.sha256,
    });
    await call("validate", { target: "simulation" });
    const other = await connect(root, t);
    const [a, b] = await Promise.all([
      call("job_start", { target: "simulation", requestId: "broken" }),
      other.call("job_start", { target: "simulation", requestId: "broken" }),
    ]);
    assert.equal(a.id, b.id);
    assert.ok(a.deduplicated || b.deduplicated);
    await client.close();
    const fresh = await connect(root, t);
    assert.equal(
      (
        await fresh.call("job_start", {
          target: "simulation",
          requestId: "broken",
        })
      ).id,
      a.id,
    );
    const failed = await finish(fresh.call, a.id);
    assert.equal(failed.state, "failed");
    assert.equal(
      (await fresh.call("checks", { target: "simulation" })).ready,
      false,
    );
    assert.equal(
      (
        await fresh.raw("job_start", {
          target: "synthesis",
          requestId: "broken",
        })
      ).error.code,
      "REQUEST_CONFLICT",
    );
    const artifacts = await fresh.call("artifacts", { run: failed.run });
    const debug = artifacts.items.find((a) => a.kind === "hdl-debug");
    assert.ok(debug, JSON.stringify(artifacts));
    const graph = await fresh.call("hardware", {
      artifact: debug.id,
      query: "value",
    });
    assert.ok(graph.items.length);
    const object = graph.items.find((o) => o.observed);
    assert.ok(object);
    const trace = await fresh.call("trace", {
      artifact: debug.id,
      object: object.id,
      limit: 5,
    });
    assert.ok(trace.items.length);
    assert.ok(object.source);
    const source = await fresh.call("source", {
      artifact: debug.id,
      source: object.source.file,
    });
    assert.ok(source.text.includes("module"));
    const screen = await fresh.call("snapshot", {
      artifact: debug.id,
      object: object.id,
      columns: 80,
      rows: 24,
    });
    assert.match(screen.text, /SCHEMATIC/);
    await fresh.call("file_write", {
      path: "engine.sv",
      text: hardware.text,
      expectedHash: broken.sha256,
    });
    const success = await fresh.call("job_start", {
      target: "simulation",
      requestId: "fixed",
    });
    const done = await finish(fresh.call, success.id);
    assert.equal(done.state, "completed", JSON.stringify(done));
    assert.equal(
      (await fresh.call("checks", { target: "simulation" })).ready,
      true,
    );
    const image = await fresh.call("file_read", { path: "program.json" }),
      second = await fresh.call("file_read", { path: "second-program.json" });
    await fresh.call("file_write", {
      path: "program.json",
      text: second.text,
      expectedHash: image.sha256,
    });
    assert.equal(
      (await fresh.call("checks", { target: "simulation" })).ready,
      false,
    );
    const secondJob = await fresh.call("job_start", {
      target: "simulation",
      requestId: "second",
    });
    const secondDone = await finish(fresh.call, secondJob.id);
    assert.equal(secondDone.state, "completed");
    assert.equal(
      (await fresh.call("file_read", { path: "engine.sv" })).sha256,
      hardware.sha256,
    );
    const comparison = await fresh.call("compare", {
      left: done.run,
      right: secondDone.run,
    });
    assert.ok(comparison.artifacts.some((a) => a.change === "changed"));
    assert.equal(comparison.roles.hardware.identical, true);
    assert.equal(comparison.roles.program.identical, false);
    assert.equal(comparison.roles.tests.identical, true);
    const invalid = JSON.parse(second.text);
    invalid.instructions[0].value = 100;
    const secondImage = await fresh.call("file_read", { path: "program.json" });
    await fresh.call("file_write", {
      path: "program.json",
      text: JSON.stringify(invalid),
      expectedHash: secondImage.sha256,
    });
    const invalidJob = await fresh.call("job_start", {
      target: "simulation",
      requestId: "invalid",
    });
    const invalidDone = await finish(fresh.call, invalidJob.id);
    assert.equal(invalidDone.state, "failed");
    assert.equal(
      (await fresh.call("file_read", { path: "engine.sv" })).sha256,
      hardware.sha256,
    );
    const retried = await fresh.call("job_retry", { job: success.id });
    assert.equal(retried.snapshot, success.snapshot);
    assert.equal((await finish(fresh.call, retried.id)).state, "completed");
    const synthesis = await fresh.call("job_start", {
      target: "synthesis",
      requestId: "synthesis",
    });
    const synthesized = await finish(fresh.call, synthesis.id);
    assert.equal(synthesized.state, "completed");
    const netlist = (
      await fresh.call("artifacts", { run: synthesized.run })
    ).items.find((a) => a.path === "netlist.json");
    assert.ok(netlist);
    assert.equal(
      (await fresh.call("hardware", { artifact: netlist.id })).abstraction,
      "synthesized-module-definitions",
    );
    const bundle = await fresh.call("export", {
      id: done.run,
      destination: "release",
    });
    assert.ok(bundle.objects > 0);
    assert.equal(
      (await fresh.raw("file_read", { path: "../../etc/passwd" })).ok,
      false,
    );
  },
);

test(
  "official SDK: separate roots, candidate jobs, bounded waits and explicit cancellation",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const roots = await Promise.all(
      [1, 2].map(() => mkdtemp(join(tmpdir(), "chipsim-mcp-isolation-"))),
    );
    t.after(() =>
      Promise.all(
        roots.map((root) => rm(root, { recursive: true, force: true })),
      ),
    );
    const a = await connect(roots[0], t),
      b = await connect(roots[1], t);
    for (const [client, name] of [
      [a, "first"],
      [b, "second"],
    ])
      await client.call("file_write", {
        path: "identity.txt",
        text: name,
        expectedHash: null,
      });
    assert.equal(
      (await a.call("file_read", { path: "identity.txt" })).text,
      "first",
    );
    assert.equal(
      (await b.call("file_read", { path: "identity.txt" })).text,
      "second",
    );
    const config = {
      format: "chipsim-design",
      version: 1,
      id: "cancel",
      tasks: {
        wait: {
          adapter: "command",
          inputs: ["wait.mjs"],
          options: { command: process.execPath, args: ["wait.mjs"] },
        },
      },
      targets: {
        wait: { tasks: ["wait"], requiredChecks: ["wait:execution"] },
      },
    };
    for (const [path, text] of [
      ["chipsim.design.json", JSON.stringify(config)],
      [
        "chipsim.lock.json",
        JSON.stringify({
          format: "chipsim-lock",
          version: 1,
          dependencies: [],
        }),
      ],
      ["wait.mjs", 'setTimeout(()=>console.log("finished"),20000)'],
    ])
      await a.call("file_write", { path, text, expectedHash: null });
    const candidate = await a.call("candidate_create", {
      label: "cancel test",
    });
    const started = await a.call("job_start", {
      candidate: candidate.id,
      target: "wait",
      requestId: "cancel",
    });
    const waiting = await a.call("job_status", {
      candidate: candidate.id,
      job: started.id,
      waitMs: 50,
    });
    assert.equal(waiting.waitingStopped, true);
    assert.equal((await b.raw("job_status", { job: started.id })).ok, false);
    await a.call("job_cancel", { candidate: candidate.id, job: started.id });
    const done = await finish(
      (name, args) => a.call(name, { ...args, candidate: candidate.id }),
      started.id,
    );
    assert.equal(done.state, "cancelled");
  },
);

test(
  "official SDK: nested HDL freshness and accepted requests survive invalid live drafts",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-mcp-nested-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { call, raw } = await connect(root, t);
    const text =
      "module top; reg clk=0; always #1 clk=~clk; initial #5 $finish; endmodule\n";
    const config = {
      format: "chipsim-design",
      version: 1,
      id: "nested",
      tasks: {
        simulate: {
          adapter: "hdl",
          options: { project: "sim/run.json" },
          outputs: [{ path: "out/debug.json", kind: "hdl-debug" }],
        },
      },
      targets: {
        simulation: {
          tasks: ["simulate"],
          requiredChecks: ["simulate:simulation"],
        },
      },
    };
    const files = {
      "top.sv": text,
      "sim/top.sv": text,
      "sim/run.json": JSON.stringify({
        format: "chipsim-hdl-project",
        version: 1,
        language: "verilog",
        top: "top",
        sources: ["top.sv"],
        waveform: "trace.vcd",
        timeoutMs: 2000,
      }),
      "chipsim.design.json": JSON.stringify(config),
      "chipsim.lock.json": JSON.stringify({
        format: "chipsim-lock",
        version: 1,
        dependencies: [],
      }),
    };
    for (const [path, text] of Object.entries(files))
      await call("file_write", { path, text, expectedHash: null });
    const args = { target: "simulation", requestId: "nested" };
    const job = await call("job_start", args),
      done = await finish(call, job.id);
    assert.equal(done.state, "completed", JSON.stringify(done));
    const artifact = (await call("artifacts", { run: done.run })).items.find(
      (a) => a.path === "out/debug.json",
    );
    const graph = await call("hardware", {
      artifact: artifact.id,
      query: "clk",
    });
    const object = graph.items.find((o) => o.observed && o.source);
    assert.ok(object);
    const sourceArgs = { artifact: artifact.id, source: object.source.file };
    const source = await call("source", sourceArgs);
    assert.equal(source.currentPath, "sim/top.sv");
    assert.equal(source.stale, false);
    const current = await call("file_read", { path: "sim/top.sv" });
    await call("file_write", {
      path: "sim/top.sv",
      text: text + "// actual nested source changed\n",
      expectedHash: current.sha256,
    });
    const manifest = await call("file_read", { path: "chipsim.design.json" });
    await call("file_write", {
      path: "chipsim.design.json",
      text: "{ unfinished draft",
      expectedHash: manifest.sha256,
    });
    const changed = await call("source", sourceArgs);
    assert.equal(changed.currentPath, "sim/top.sv");
    assert.equal(changed.stale, true);
    assert.equal(changed.text, text);
    const replay = await call("job_start", args);
    assert.equal(replay.id, job.id);
    assert.equal(replay.run, done.run);
    assert.equal(replay.deduplicated, true);
    assert.equal(
      (await raw("job_start", { ...args, reuse: false })).error.code,
      "REQUEST_CONFLICT",
    );
    assert.equal(
      (await raw("job_start", { ...args, requestId: "new" })).ok,
      false,
    );
  },
);
