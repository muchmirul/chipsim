import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const chipsimCLI = fileURLToPath(
  new URL("../../scripts/chipsim.mjs", import.meta.url),
);

// Compiled prime-agent runs on Bun: its executable is not a Node interpreter.
export function nodeCommand(env = process.env, versions = process.versions) {
  return env.CHIPSIM_NODE || (versions.bun ? "node" : process.execPath);
}

export class ChipSimProcessError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ChipSimProcessError";
    this.details = details;
  }
}

export async function runChipSim(
  args,
  {
    cwd,
    signal,
    timeout = 180000,
    maxBytes = 4 * 1048576,
    executable = nodeCommand(),
    cli = chipsimCLI,
    textOutput = false,
  } = {},
) {
  if (signal?.aborted)
    throw new ChipSimProcessError("ChipSim cancelled before starting.", {
      cancelled: true,
    });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [cli, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const stdout = [],
      stderr = [];
    let bytes = 0,
      stopped,
      killTimer,
      spawnError;
    const kill = (signalName) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch (error) {
        if (error.code !== "ESRCH") spawnError ??= error;
      }
    };
    const stop = (reason) => {
      if (stopped) return;
      stopped = reason;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 250);
      killTimer.unref();
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), timeout);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ])
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) stop("output limit");
        else chunks.push(chunk);
      });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(timer);
      if (!stopped) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      const output = Buffer.concat(stdout).toString("utf8");
      const diagnostics = Buffer.concat(stderr).toString("utf8").slice(0, 8192);
      let result;
      try {
        result = textOutput ? { text: output } : JSON.parse(output);
      } catch {}
      const details = {
        exitCode,
        signal: exitSignal,
        result,
        stderr: diagnostics,
        ...(stopped
          ? { reason: stopped, cancelled: stopped === "cancelled" }
          : {}),
      };
      if (stopped || spawnError)
        reject(
          new ChipSimProcessError(
            `ChipSim ${stopped || "could not start"}: ${spawnError?.message || "inspect any partial output before choosing a new run directory."}`,
            details,
          ),
        );
      else if (
        !textOutput &&
        (!result ||
          ![
            "chipsim-agent-result",
            "chipsim-hdl-result",
            "chipsim-design-result",
          ].includes(result.format) ||
          result.version !== 1 ||
          typeof result.ok !== "boolean")
      )
        reject(
          new ChipSimProcessError(
            "ChipSim returned an invalid result envelope." +
              (diagnostics ? "\n" + diagnostics : ""),
            details,
          ),
        );
      else if (exitCode !== 0 || (!textOutput && !result.ok))
        // Throwing is the shared error contract of Pi and prime-agent. Preserve
        // the complete CLI failure, including diagnostics and fault artifacts.
        reject(
          new ChipSimProcessError(
            `ChipSim failed (exit ${exitCode}):\n${JSON.stringify(details)}`,
            details,
          ),
        );
      else resolve(result);
    });
  });
}
