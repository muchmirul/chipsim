#!/usr/bin/env node
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
    assert.equal(native.tools.size, 17);
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
    const context = (await call("chipsim_context", { target: "pio" })).details
      .programmingContext;
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
    console.log(
      `${host.name}: native loader registered 17 tools and /chipsim; checked/executed PIO (decoded 179) and rendered saved session.`,
    );
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
