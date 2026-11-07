// Public CLI transport. Python owns the shared evaluator; ChipSim owns jobs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(
  new URL("../../examples/evolution/command.py", import.meta.url),
);

export async function main(args) {
  const textOutput =
    args.includes("--format=text") ||
    (args.includes("--format") &&
      args[args.indexOf("--format") + 1] === "text");
  const help =
    !args.length ||
    args.includes("--help") ||
    args.includes("-h") ||
    args[0] === "help";
  const child = spawn(
    process.env.PYTHON || "python3",
    [entry, ...(help ? ["--help"] : args)],
    {
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  let output = "",
    diagnostics = "",
    error,
    killTimer;
  const stop = () => {
    if (killTimer) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") process.stderr.write(error.message + "\n");
      }
    }, 15000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.stdout.on("data", (data) => {
    if (error) return;
    output += data;
    if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
      error = "Evolution output exceeded 2 MiB";
      stop();
    }
  });
  child.stderr.on("data", (data) => {
    diagnostics = (diagnostics + data).slice(-8192);
    process.stderr.write(data);
  });
  child.on("error", (e) => {
    error = e.message;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  clearTimeout(killTimer);
  if (!error && !help && !textOutput) {
    try {
      const result = JSON.parse(output);
      if (
        result.format !== "chipsim-evolution-result" ||
        result.version !== 1 ||
        typeof result.ok !== "boolean"
      )
        throw new Error("Invalid evolution result envelope");
    } catch (e) {
      error = diagnostics || e.message;
    }
  }
  if (error) {
    process.stdout.write(
      JSON.stringify({
        format: "chipsim-evolution-result",
        version: 1,
        command: args[0],
        ok: false,
        result: { status: "error", message: error },
      }) + "\n",
    );
  } else process.stdout.write(output);
  process.exitCode = error ? 1 : (code ?? 130);
}
