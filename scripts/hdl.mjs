import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { readJSON, createDirectory, jsonText } from "../src/agent/io.js";
import { readWaveform, readComparisonTrace } from "../src/hdl/io.js";
import { hdlDoctor, runHDL } from "../src/hdl/run.js";
import { compareBehavior } from "../src/hdl/compare.js";

export const usage = `HDL workbench (local external simulators)
  chipsim hdl doctor
  chipsim hdl import trace.vcd --out NEW_DIRECTORY
  chipsim hdl run project.json --out NEW_DIRECTORY
  chipsim hdl compare LEFT.vcd|json RIGHT.vcd|json --map mapping.json [--out NEW_DIRECTORY]
  chipsim --vcd trace.vcd|waveform.json
  chipsim --hdl project.json --hdl-out NEW_DIRECTORY
Verilog: Icarus Verilog (iverilog + vvp). VHDL: GHDL.
See docs/HDL.md for manifest, explicit timing/mapping and comparison limits.
`;

export async function main(args = process.argv.slice(2)) {
  let exitCode = 0,
    report;
  try {
    const [command, ...rest] = args;
    if (!command || ["help", "--help", "-h"].includes(command)) {
      report = {
        format: "chipsim-hdl-result",
        version: 1,
        ok: true,
        help: usage,
      };
    } else {
      const positional = [],
        options = {};
      for (let i = 0; i < rest.length; i++) {
        const value = rest[i];
        if (value.startsWith("--")) {
          const key = value.slice(2);
          if (
            !["out", "map"].includes(key) ||
            options[key] ||
            !rest[i + 1] ||
            rest[i + 1].startsWith("--")
          )
            throw new Error("Unknown, duplicate or incomplete option " + value);
          options[key] = rest[++i];
        } else positional.push(value);
      }
      const requireArgs = (count, keys) => {
        if (
          positional.length !== count ||
          Object.keys(options).some((k) => !keys.includes(k))
        )
          throw new Error("Invalid arguments. " + usage);
      };
      if (command === "doctor") {
        requireArgs(0, []);
        report = {
          format: "chipsim-hdl-result",
          version: 1,
          ok: true,
          tools: await hdlDoctor(),
        };
      } else if (command === "run" || command === "import") {
        requireArgs(1, ["out"]);
        if (!options.out)
          throw new Error("Choose a new output directory with --out.");
        if (command === "run")
          report = (await runHDL(positional[0], options.out)).result;
        else {
          const wave = await readWaveform(positional[0]);
          report = await createDirectory(options.out, async (root) => {
            const path = resolve(root, "waveform.json");
            await writeFile(path, jsonText(wave), { flag: "wx" });
            return {
              format: "chipsim-hdl-result",
              version: 1,
              ok: true,
              artifacts: { waveform: path },
              signals: wave.signals.length,
              samples: wave.events.length,
              tui: ["chipsim", "--vcd", path],
            };
          });
        }
        if (!report.ok) exitCode = 1;
      } else if (command === "compare") {
        requireArgs(2, ["map", "out"]);
        if (!options.map)
          throw new Error("Comparison requires --map mapping.json.");
        const left = await readComparisonTrace(positional[0]),
          right = await readComparisonTrace(positional[1]),
          config = await readJSON(options.map, 65536);
        const comparison = compareBehavior(left, right, config);
        report = {
          format: "chipsim-hdl-result",
          version: 1,
          ok: true,
          comparison,
        };
        if (options.out)
          await createDirectory(options.out, async (root) => {
            const path = resolve(root, "comparison.json");
            await writeFile(path, jsonText(comparison), { flag: "wx" });
            report.artifacts = { comparison: path };
          });
        if (!comparison.match) exitCode = 1;
      } else throw new Error("Unknown HDL command " + command);
    }
  } catch (error) {
    exitCode = 2;
    report = {
      format: "chipsim-hdl-result",
      version: 1,
      ok: false,
      error: error.message,
    };
  }
  process.stdout.write(jsonText(report));
  process.exitCode = exitCode;
  return report;
}
