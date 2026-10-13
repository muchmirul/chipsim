import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(process.argv[2]);
const backends = {};
for (const [language, files] of Object.entries({
  verilog: {
    iverilog: "iverilog/bin/iverilog",
    vvp: "iverilog/bin/vvp",
    compiler: "iverilog/lib/ivl/ivl",
    target: "iverilog/lib/ivl/vvp.tgt",
  },
  vhdl: { ghdl: "ghdl/bin/ghdl" },
})) {
  backends[language] = {};
  for (const [name, path] of Object.entries(files))
    backends[language][name] = {
      path,
      sha256: createHash("sha256")
        .update(await readFile(resolve(root, path)))
        .digest("hex"),
    };
}
await writeFile(
  resolve(root, "chipsim-debug-tools.json"),
  JSON.stringify(
    {
      format: "chipsim-hdl-debug-tools",
      version: 1,
      instrumentation: "chipsim-1",
      source: { iverilog: "v12_0", ghdl: "v4.1.0" },
      backends,
    },
    null,
    2,
  ) + "\n",
);
