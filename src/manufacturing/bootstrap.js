import { join } from "node:path";
import { readFile, mkdir, cp, rename, rm, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  Store,
  json,
  identity,
  files,
  atomic,
  fileDigest,
} from "../design/store.js";
import { verifyDependencies, name } from "../design/project.js";
import { verifyEvidence } from "../design/evidence.js";
import { withProjectLock } from "../workbench/files.js";
import { manufacturingProfile } from "./profiles.js";

export async function environmentFromRun(root, id, profile) {
  const store = new Store(root),
    run = await verifyEvidence(store, id);
  if (
    run.format !== "chipsim-run" ||
    run.target !== "manufacturing-setup" ||
    run.state !== "completed" ||
    !run.readiness.ready
  )
    throw new Error("Expected a successful managed environment setup run");
  const artifacts = await Promise.all(
    run.artifacts.map((a) => store.get(a, "artifact")),
  );
  const artifact = artifacts.find((a) => a.path === "environment.json");
  if (!artifact)
    throw new Error("Environment setup did not publish its inventory");
  const environment = await json(store.blobPath(artifact.payload.sha256));
  const { identity: recorded, ...body } = environment;
  if (identity(body) !== recorded || environment.digest !== profile.digest)
    throw new Error(
      "Environment identity differs from the selected manufacturing profile",
    );
  await verifyDependencies(environment.dependencies, root);
  return environment;
}

export async function bootstrapProject(
  root,
  { profile: id, environment: run, metadata: m, requestId },
) {
  const profile = await manufacturingProfile(id);
  name(m.id);
  if (!/^tt_um_[A-Za-z0-9_]+$/.test(m.top) || !profile.tiles.includes(m.tiles))
    throw new Error("Unsupported top module name or tile size");
  for (const key of ["title", "author", "description", "license"])
    if (!m[key].trim()) throw new Error("Missing project " + key);
  const environment = await environmentFromRun(root, run, profile);
  const options = {
    ...profile.pins,
    pdk: profile.pdk,
    pdkRoot: environment.pdkRoot,
    python: environment.python,
    precheckPython: environment.precheckPython,
  };
  const digital = (operation) => ({
    adapter: "tinytapeout-verify",
    inputs: ["src", "manufacturing.json"],
    options: {
      operation,
      sources: operation === "gate" ? [] : ["src/project.v"],
      top: m.top,
      python: environment.python,
      pdkRoot: environment.pdkRoot,
      image: profile.pins.image,
    },
    outputs:
      operation === "synthesis"
        ? [
            { path: "synthesis.json", kind: "netlist-graph" },
            { path: "synthesis.v", kind: "netlist" },
          ]
        : [{ path: "results.xml", kind: "test-report" }],
  });
  const top = "tt_submission/" + m.top;
  const config = {
    format: "chipsim-design",
    version: 1,
    id: m.id,
    name: m.title,
    engineering: {
      roles: {
        hardware: ["src/project.v"],
        tests: ["test/tb.sv", "acceptance.json"],
        constraints: ["src/config.json"],
      },
    },
    tasks: {
      rtl: digital("rtl"),
      synthesis: { ...digital("synthesis"), needs: ["rtl"] },
      physical: {
        adapter: "tinytapeout",
        needs: ["synthesis"],
        inputs: [
          "manufacturing.json",
          "docs",
          "LICENSE",
          "acceptance.json",
          "test",
        ],
        options,
        timeoutMs: 3600000,
        outputs: [
          { path: top + ".gds", kind: "layout" },
          { path: top + ".oas", kind: "layout" },
          { path: top + ".lef", kind: "physical-abstract" },
          { path: top + ".v", kind: "netlist" },
          { path: "out/physical.json", kind: "physical-report" },
          { path: "tt/precheck/reports/results.xml", kind: "test-report" },
        ],
      },
      gate: {
        ...digital("gate"),
        bindings: [
          {
            task: "physical",
            output: top + ".v",
            path: "gate_level_netlist.v",
          },
        ],
      },
    },
    targets: {
      simulation: {
        tasks: ["rtl"],
        requiredChecks: ["rtl:tests", "rtl:outputs"],
      },
      synthesis: {
        tasks: ["synthesis"],
        requiredChecks: ["synthesis:synthesis", "rtl:tests"],
      },
      release: { tasks: ["gate"], requiredChecks: [...profile.requiredChecks] },
    },
  };
  const pinout = {};
  for (const [prefix, values] of Object.entries(m.pinout))
    values.forEach((value, i) => {
      pinout[prefix + "[" + i + "]"] = value;
    });
  const info = {
    project: {
      title: m.title,
      author: m.author,
      description: m.description,
      language: "Verilog",
      clock_hz: m.clockHz,
      tiles: m.tiles,
      top_module: m.top,
      source_files: ["project.v"],
    },
    pinout,
    yaml_version: 6,
  };
  const flow = JSON.parse(
    await readFile(join(environment.template, "src/config.json"), "utf8"),
  );
  flow.CLOCK_PERIOD = 1e9 / m.clockHz;
  flow.RUN_KLAYOUT_DRC = 1;
  const manufacturing = {
    format: "chipsim-manufacturing",
    version: 1,
    profile: profile.id,
    profileDigest: profile.digest,
    environment: run,
    metadata: m,
  };
  const content = {
    "chipsim.design.json": config,
    "chipsim.lock.json": {
      format: "chipsim-lock",
      version: 1,
      dependencies: environment.dependencies,
    },
    "manufacturing.json": manufacturing,
    "flow-pins.json": profile.pins,
    "info.yaml": info,
    "src/config.json": flow,
    "acceptance.json": { cases: ["implement-specification"] },
    "src/project.v": `// Implement the requirements in docs/requirements.md.\nmodule ${m.top}(input wire [7:0] ui_in, output wire [7:0] uo_out, input wire [7:0] uio_in, output wire [7:0] uio_out, uio_oe, input wire ena, clk, rst_n);\nassign uo_out = 0; assign uio_out = 0; assign uio_oe = 0;\nendmodule\n`,
    "test/tb.sv":
      '`timescale 1ns/1ps\nmodule tb; initial $fatal(1, "Implement independent acceptance tests for the specified hardware"); endmodule\n',
    "docs/requirements.md": `# ${m.title}\n\n${m.description}\n\nRecord reset behavior, input/output behavior, boundary cases, timing requirements and their acceptance tests before implementation.\n`,
    "docs/info.md": `# ${m.title}\n\n${m.description}\n\nClock: ${m.clockHz} Hz. Tiles: ${m.tiles}.\n\nDescribe operation and how to test the manufactured chip.\n`,
    LICENSE: m.license,
  };
  return withProjectLock(root, async () => {
    const stage = join(root, ".chipsim", "bootstrap-" + randomUUID()),
      installed = [];
    await mkdir(stage, { recursive: true });
    try {
      const { writeFile } = await import("node:fs/promises");
      for (const [path, value] of Object.entries(content)) {
        await mkdir(join(stage, path, ".."), { recursive: true });
        await writeFile(
          join(stage, path),
          typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2) + "\n",
        );
      }
      await cp(environment.support, join(stage, "tt"), {
        recursive: true,
        filter: (path) =>
          !path.split("/").some((p) => [".git", "__pycache__"].includes(p)),
      });
      const playbook = await readFile(
        new URL("../../docs/MANUFACTURING.md", import.meta.url),
        "utf8",
      );
      await writeFile(join(stage, "MANUFACTURING.md"), playbook);
      const result = {
        profile: profile.id,
        environment: run,
        targets: Object.keys(config.targets),
        files: Object.keys(content),
        next: "Implement requirements, RTL and independent acceptance tests; then run the release target.",
      };
      const inventory = await Promise.all(
        (await files(stage)).map(async (path) => ({
          path,
          ...(await fileDigest(join(stage, path))),
        })),
      );
      const receiptPath =
        requestId &&
        join(
          root,
          ".chipsim/bootstrap-requests",
          identity(requestId) + ".json",
        );
      let receipt;
      if (receiptPath) {
        receipt = await json(receiptPath).catch((e) => {
          if (e.code !== "ENOENT") throw e;
          return null;
        });
        const key = identity({ id, run, m });
        if (receipt && receipt.key !== key)
          throw new Error(
            "Bootstrap requestId was used with different parameters",
          );
        if (receipt && identity(receipt.inventory) !== identity(inventory))
          throw new Error("Bootstrap template changed since request");
        if (receipt) {
          // Only exact files owned by this request can be reconciled. Extra or
          // edited files abort rather than being mistaken for a completed reply.
          for (const top of receipt.names) {
            let present;
            try {
              present = await lstat(join(root, top));
            } catch (e) {
              if (e.code === "ENOENT") continue;
              throw e;
            }
            if (present.isSymbolicLink())
              throw new Error("Unsafe bootstrap destination: " + top);
            const actual = present.isDirectory()
              ? await files(root, [top])
              : [top];
            const expected = receipt.inventory.filter(
              (f) => f.path === top || f.path.startsWith(top + "/"),
            );
            if (
              identity(actual.sort()) !==
              identity(expected.map((f) => f.path).sort())
            )
              throw new Error("Conflicting partial bootstrap: " + top);
            for (const f of expected)
              if ((await fileDigest(join(root, f.path))).sha256 !== f.sha256)
                throw new Error("Bootstrap file changed: " + f.path);
          }
        }
      }
      // Check every top-level destination before the first project mutation.
      const names = [
        ...new Set((await files(stage)).map((p) => p.split("/")[0])),
      ];
      for (const path of names) {
        try {
          await lstat(join(root, path));
          if (receipt) continue;
          throw new Error("Bootstrap would overwrite " + path);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      if (receiptPath && !receipt) {
        receipt = {
          key: identity({ id, run, m }),
          inventory,
          names,
          result,
          complete: false,
        };
        await atomic(receiptPath, receipt);
      }
      for (const path of names) {
        if (receiptPath) {
          try {
            await lstat(join(root, path));
            continue;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }
        await rename(join(stage, path), join(root, path));
        installed.push(path);
      }
      if (receiptPath)
        await atomic(receiptPath, { ...receipt, complete: true });
      return result;
    } catch (e) {
      for (const path of requestId ? [] : installed)
        await rm(join(root, path), { recursive: true, force: true });
      throw e;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
}
