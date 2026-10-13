import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";
import { readBounded, readJSON } from "../../agent/io.js";
import { digest } from "../io.js";

export const debugToolRoot = () =>
  resolve(
    process.env.CHIPSIM_HDL_DEBUG_TOOLS ||
      resolve(homedir(), ".local/share/chipsim-debug-tools"),
  );

export async function debugTools() {
  const root = debugToolRoot();
  try {
    const manifest = await readJSON(
      resolve(root, "chipsim-debug-tools.json"),
      65536,
    );
    if (
      manifest.format !== "chipsim-hdl-debug-tools" ||
      manifest.version !== 1 ||
      manifest.instrumentation !== "chipsim-1"
    )
      throw new Error("incompatible instrumented toolchain manifest");
    const results = {};
    for (const [language, names] of Object.entries({
      verilog: ["iverilog", "vvp", "compiler", "target"],
      vhdl: ["ghdl"],
    })) {
      const commands = {};
      try {
        for (const name of names) {
          const entry = manifest.backends?.[language]?.[name];
          if (
            !entry ||
            typeof entry.path !== "string" ||
            isAbsolute(entry.path) ||
            entry.path.split(/[\\/]/).includes("..") ||
            typeof entry.sha256 !== "string"
          )
            throw new Error("missing or invalid instrumented " + name);
          const path = resolve(root, entry.path);
          if (digest(await readBounded(path, 128 * 1048576)) !== entry.sha256)
            throw new Error(
              "instrumented " +
                name +
                " fingerprint differs from the build manifest",
            );
          commands[name] = path;
        }
        results[language] = {
          available: true,
          commands,
          instrumentation: manifest.instrumentation,
          source: manifest.source,
        };
      } catch (error) {
        results[language] = { available: false, reason: error.message };
      }
    }
    return { root, ...results };
  } catch (error) {
    const reason = `Debug capture toolchain unavailable: ${error.message}. Build with scripts/build-hdl-debug.sh; see docs/HDL_DEBUG.md. For waveform-only simulation use --no-debug (managed tasks: options.debug=false).`;
    return {
      root,
      verilog: { available: false, reason },
      vhdl: { available: false, reason },
    };
  }
}
