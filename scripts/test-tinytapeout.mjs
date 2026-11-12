import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { files } from "../src/design/store.js";
import { dependencyIdentity, loadDesign } from "../src/design/project.js";
import { startJob, waitJob } from "../src/design/jobs.js";
import { checksForTarget } from "../src/design/service.js";
const exec = promisify(execFile);
const required = [
  "CHIPSIM_TT_TEMPLATE",
  "CHIPSIM_TT_SUPPORT",
  "CHIPSIM_TT_PDK_ROOT",
  "CHIPSIM_TT_PYTHON",
  "CHIPSIM_TT_PRECHECK_PYTHON",
];
for (const name of required)
  if (!process.env[name])
    throw new Error(
      "Native acceptance requires " + name + "; see docs/TINYTAPEOUT.md",
    );
const root = await mkdtemp(join(tmpdir(), "chipsim-tinytapeout-"));
console.log("Disposable native project: " + root);
await mkdir(join(root, "src"));
await mkdir(join(root, "tt"));
const template = process.env.CHIPSIM_TT_TEMPLATE,
  support = process.env.CHIPSIM_TT_SUPPORT;
const head = async (path) =>
  (await exec("git", ["-C", path, "rev-parse", "HEAD"])).stdout.trim();
const pins = {
  templateRevision: await head(template),
  supportRevision: await head(support),
  pdkRevision: "2bbec755dc67ca3db0261c3d6163e15735d66710",
  image:
    "ghcr.io/librelane/librelane@sha256:d109140b8f17fc54f4fca998beb8124f4949404ec52e339eebd2250854a18b5a",
  librelaneVersion: "3.1.0.dev3",
};
// Archive only public tracked support-tool bytes; no repository metadata or reports.
await exec("git", [
  "-C",
  support,
  "archive",
  "--format=tar",
  "--output=" + join(root, "support.tar"),
  "HEAD",
]);
await exec("tar", ["-xf", join(root, "support.tar"), "-C", join(root, "tt")]);
await copyFile(
  join(template, "src/config.json"),
  join(root, "src/config.json"),
);
// The official template disables flow DRC; enable its native KLayout step explicitly
// for this independent acceptance fixture so DRC is evidence, not a skipped pass.
const config = JSON.parse(
  await readFile(join(root, "src/config.json"), "utf8"),
);
config.RUN_KLAYOUT_DRC = 1;
await writeFile(join(root, "src/config.json"), JSON.stringify(config, null, 2));
let info = await readFile(join(template, "info.yaml"), "utf8");
info = info
  .replace(
    'top_module:  "tt_um_example"',
    'top_module:  "tt_um_chipsim_fixture"',
  )
  .replace("clock_hz:     0", "clock_hz:     50000000")
  .replace(
    'title:        ""',
    'title:        "ChipSim independent counter fixture"',
  )
  .replace('author:       ""', 'author:       "ChipSim"')
  .replace(
    'description:  ""',
    'description:  "Independent counter and XOR physical acceptance fixture"',
  );
await writeFile(join(root, "info.yaml"), info);
await writeFile(
  join(root, "src/project.v"),
  `// SPDX-License-Identifier: MIT
// Original ChipSim physical acceptance fixture; no challenge implementation.
module tt_um_chipsim_fixture(input wire [7:0] ui_in, output wire [7:0] uo_out,
 input wire [7:0] uio_in, output wire [7:0] uio_out, uio_oe,
 input wire ena, clk, rst_n);
 reg [7:0] count;
 always @(posedge clk) if (!rst_n) count <= 0; else if (ena) count <= count + 1;
 assign uo_out = count;
 assign uio_out = ui_in ^ uio_in;
 assign uio_oe = 8'hff;
endmodule
`,
);
await writeFile(join(root, "flow-pins.json"), JSON.stringify(pins, null, 2));
const pdkRoot = process.env.CHIPSIM_TT_PDK_ROOT;
console.log("Inventorying pinned PDK contents");
const dependency = {
  path: pdkRoot,
  sha256: await dependencyIdentity(pdkRoot),
  tasks: ["physical"],
};
await writeFile(
  join(root, "chipsim.lock.json"),
  JSON.stringify({
    format: "chipsim-lock",
    version: 1,
    dependencies: [dependency],
  }),
);
await writeFile(
  join(root, "chipsim.design.json"),
  JSON.stringify(
    {
      format: "chipsim-design",
      version: 1,
      id: "tinytapeout-fixture",
      tasks: {
        physical: {
          adapter: "tinytapeout",
          timeoutMs: 1800000,
          options: {
            ...pins,
            pdk: "ihp-sg13cmos5l",
            pdkRoot,
            python: process.env.CHIPSIM_TT_PYTHON,
            precheckPython: process.env.CHIPSIM_TT_PRECHECK_PYTHON,
          },
          outputs: [
            { path: "out/physical.json", kind: "physical-report" },
            { path: "tt/precheck/reports/results.xml", kind: "test-report" },
            { path: "tt_submission/tt_um_chipsim_fixture.gds", kind: "layout" },
          ],
        },
      },
      targets: {
        physical: {
          tasks: ["physical"],
          requiredChecks: [
            "physical:outputs",
            "physical:timing",
            "physical:drc",
            "physical:lvs",
            "physical:precheck",
          ],
        },
      },
    },
    null,
    2,
  ),
);
const job = await startJob(root, "physical", { reuse: false });
console.log("Managed job: " + job.id);
const { store } = await loadDesign(root);
let state;
do {
  state = await waitJob(store, job.id, { timeoutMs: 10000 });
  console.log(state.state + (state.error ? " " + state.error : ""));
} while (state.waitingStopped);
console.log(JSON.stringify(state, null, 2));
const checks = await checksForTarget(root, "physical");
console.log(JSON.stringify(checks, null, 2));
assert.equal(state.state, "completed");
assert.equal(
  checks.ready,
  true,
  "Native timing/DRC/LVS/precheck must all pass",
);
console.log(
  "Real Tiny Tapeout/LibreLane + native precheck acceptance passed. Evidence retained at " +
    root,
);
