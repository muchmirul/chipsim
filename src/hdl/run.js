import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir, lstat, stat } from "node:fs/promises";
import { resolve, dirname, relative, join, isAbsolute } from "node:path";
import {
  readJSON,
  readBounded,
  createDirectory,
  jsonText,
} from "../agent/io.js";
import { digest, readWaveform } from "./io.js";
import { timeScale } from "./time.js";
import { limits } from "./vcd.js";

// No shell, custom commands or loadable simulator plugins in the manifest.
// HDL is executed only by the explicit run action, never by trace import.
export async function processRun(
  command,
  args,
  { cwd, timeoutMs = 30000, signal, waveformPath } = {},
) {
  return new Promise((done) => {
    if (signal?.aborted)
      return done({
        ok: false,
        command,
        args,
        reason: "cancelled",
        stdout: "",
        stderr: "",
      });
    let stdout = "",
      stderr = "",
      bytes = 0,
      reason;
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    const kill = (why) => {
      reason ||= why;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const onAbort = () => kill("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const watch = waveformPath
      ? setInterval(async () => {
          try {
            if ((await stat(waveformPath)).size > limits.bytes)
              kill("waveform exceeds 64 MiB");
          } catch {
            /* not written yet */
          }
        }, 100)
      : null;
    const collect = (stream) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 1048576) return kill("diagnostics exceed 1 MiB");
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.once("error", (error) => {
      reason =
        error.code === "ENOENT"
          ? command + " is not installed or not on PATH"
          : error.message;
    });
    child.once("close", (code, termination) => {
      clearTimeout(timer);
      clearInterval(watch);
      signal?.removeEventListener("abort", onAbort);
      done({
        ok: code === 0 && !reason,
        command,
        args,
        code,
        signal: termination,
        reason: reason || null,
        stdout,
        stderr,
      });
    });
  });
}

export async function hdlDoctor() {
  const commands = await Promise.all([
    processRun("iverilog", ["-V"]),
    processRun("vvp", ["-V"]),
    processRun("ghdl", ["--version"]),
  ]);
  return commands.map((r) => ({
    command: r.command,
    available: r.ok,
    version: (r.stdout || r.stderr).split("\n")[0],
    reason: r.reason,
  }));
}

export async function readProject(file) {
  const project = await readJSON(file, 65536),
    base = dirname(resolve(file));
  if (
    project?.format !== "chipsim-hdl-project" ||
    project.version !== 1 ||
    !["verilog", "vhdl"].includes(project.language)
  )
    throw new Error(
      "Expected a version-1 chipsim-hdl-project with language verilog or vhdl.",
    );
  const allowed = new Set([
    "format",
    "version",
    "name",
    "language",
    "sources",
    "includeDirs",
    "assets",
    "top",
    "standard",
    "waveform",
    "timeoutMs",
    "stopTime",
    "parameters",
  ]);
  for (const key of Object.keys(project))
    if (!allowed.has(key)) throw new Error("Unknown HDL project field " + key);
  if (
    typeof project.top !== "string" ||
    project.top.length > 128 ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(project.top)
  )
    throw new Error("HDL project requires a simple top module/entity name.");
  const path = (value) => {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 512 ||
      isAbsolute(value) ||
      /[\x00-\x1f]/.test(value)
    )
      throw new Error("Project paths must be relative to the manifest.");
    const absolute = resolve(base, value),
      rel = relative(base, absolute);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Project paths must stay inside the manifest directory.");
    return rel;
  };
  const lists = {};
  for (const key of ["sources", "includeDirs", "assets"]) {
    const list = project[key] || [];
    if (
      !Array.isArray(list) ||
      list.length > 128 ||
      (key === "sources" && !list.length)
    )
      throw new Error(
        "HDL sources/includes/assets require bounded path arrays.",
      );
    lists[key] = list.map(path);
    if (new Set(lists[key]).size !== list.length)
      throw new Error("Duplicate " + key + " entries.");
  }
  const standard =
    project.standard || (project.language === "verilog" ? "2005" : "08");
  if (
    !(
      project.language === "verilog"
        ? ["1995", "2001", "2005", "2005-sv", "2009", "2012"]
        : ["87", "93", "00", "02", "08"]
    ).includes(standard)
  )
    throw new Error("Unsupported HDL language standard.");
  const waveform = project.waveform || "trace.vcd";
  if (!/^[a-zA-Z0-9_-]+\.vcd$/.test(waveform))
    throw new Error(
      "waveform must be a simple .vcd filename written by the testbench.",
    );
  const timeoutMs = project.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
    throw new Error("timeoutMs must be 100–120000.");
  if (project.stopTime) timeScale(project.stopTime);
  if (project.language === "verilog" && project.stopTime)
    throw new Error(
      "Verilog stop time belongs in the testbench; timeoutMs bounds real execution time.",
    );
  const parameters = project.parameters || {};
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    Object.keys(parameters).length > 64 ||
    Object.entries(parameters).some(
      ([k, v]) =>
        !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) || !Number.isSafeInteger(v),
    )
  )
    throw new Error("HDL parameters/generics must be named integer values.");
  return {
    ...project,
    ...lists,
    standard,
    waveform,
    timeoutMs,
    parameters,
    base,
  };
}

export async function runHDL(
  file,
  destination,
  { signal, onProgress = () => {} } = {},
) {
  if (!signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      return await runHDL(file, destination, {
        signal: controller.signal,
        onProgress,
      });
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
  const project = await readProject(file);
  return createDirectory(destination, async (root) => {
    const sourceRoot = join(root, "sources"),
      files = new Set([...project.sources, ...project.assets]);
    let directories = 0;
    const include = async (dir) => {
      if (++directories > 256 || dir.length > 512)
        throw new Error("HDL includes exceed directory/path limits.");
      if (!(await lstat(join(project.base, dir))).isDirectory())
        throw new Error("Include path must be a regular directory.");
      for (const entry of await readdir(join(project.base, dir), {
        withFileTypes: true,
      })) {
        const name = join(dir, entry.name);
        if (entry.isSymbolicLink())
          throw new Error("HDL includes cannot contain symbolic links.");
        if (entry.isDirectory()) await include(name);
        else if (entry.isFile()) files.add(name);
        if (files.size > 256)
          throw new Error("HDL project exceeds 256 source/asset files.");
      }
    };
    for (const dir of project.includeDirs) await include(dir);
    if (files.has(project.waveform))
      throw new Error(
        "The generated waveform cannot also be a source/asset file.",
      );
    let total = 0;
    const sources = [];
    for (const name of files) {
      // Reject symlinked path components, including parent directories.
      for (let part = name; part !== "."; part = dirname(part))
        if ((await lstat(join(project.base, part))).isSymbolicLink())
          throw new Error("HDL source paths cannot contain symbolic links.");
      const bytes = await readBounded(join(project.base, name), 4 * 1048576);
      total += bytes.length;
      if (total > 16 * 1048576)
        throw new Error("HDL source snapshot exceeds 16 MiB.");
      const copy = join(sourceRoot, name);
      await mkdir(dirname(copy), { recursive: true });
      await writeFile(copy, bytes, { flag: "wx" });
      sources.push({ file: name, bytes: bytes.length, sha256: digest(bytes) });
    }
    const { base, ...savedProject } = project;
    await writeFile(join(root, "project.json"), jsonText(savedProject));
    const versions = await Promise.all(
      (project.language === "verilog"
        ? [
            ["iverilog", "-V"],
            ["vvp", "-V"],
          ]
        : [["ghdl", "--version"]]
      ).map(([command, flag]) =>
        processRun(command, [flag], {
          cwd: sourceRoot,
          signal,
          timeoutMs: project.timeoutMs,
        }),
      ),
    );
    const tools = versions.map((r) => ({
      command: r.command,
      available: r.ok,
      version: (r.stdout || r.stderr).split("\n")[0],
      reason: r.reason,
    }));
    const stages = [],
      wavePath = join(sourceRoot, project.waveform);
    const execute = async (name, command, args) => {
      onProgress(name);
      const result = await processRun(command, args, {
        cwd: sourceRoot,
        timeoutMs: project.timeoutMs,
        signal,
        waveformPath: wavePath,
      });
      stages.push({ stage: name, ...result });
      return result.ok;
    };
    let ok;
    if (project.language === "verilog") {
      const binary = join(root, "simulation.vvp");
      const args = [
        "-g" + project.standard,
        "-s",
        project.top,
        "-o",
        binary,
        ...project.includeDirs.flatMap((dir) => ["-I", "./" + dir]),
        ...Object.entries(project.parameters).map(
          ([key, value]) => `-P${project.top}.${key}=${value}`,
        ),
        ...project.sources.map((file) => "./" + file),
      ];
      ok = await execute("compile", "iverilog", args);
      if (ok) ok = await execute("simulate", "vvp", ["-n", binary]);
    } else {
      ok = await execute("analyze", "ghdl", [
        "-a",
        "--std=" + project.standard,
        ...project.sources.map((file) => "./" + file),
      ]);
      if (ok)
        ok = await execute("elaborate", "ghdl", [
          "-e",
          "--std=" + project.standard,
          project.top,
        ]);
      if (ok)
        ok = await execute("simulate", "ghdl", [
          "-r",
          "--std=" + project.standard,
          project.top,
          ...Object.entries(project.parameters).map(
            ([key, value]) => `-g${key}=${value}`,
          ),
          "--assert-level=error",
          "--vcd=" + project.waveform,
          ...(project.stopTime ? ["--stop-time=" + project.stopTime] : []),
        ]);
    }
    let waveform, waveError;
    try {
      waveform = await readWaveform(wavePath);
      waveform.origin = {
        ...waveform.origin,
        name: project.name || project.top,
        project: savedProject,
        sources,
      };
      await writeFile(
        join(root, "trace.vcd"),
        await readBounded(wavePath, limits.bytes),
        { flag: "wx" },
      );
      await writeFile(join(root, "waveform.json"), jsonText(waveform), {
        flag: "wx",
      });
    } catch (error) {
      waveError = error.message;
    }
    ok = Boolean(ok && waveform);
    const result = {
      format: "chipsim-hdl-result",
      version: 1,
      ok,
      root,
      project: savedProject,
      sources,
      tools,
      stages,
      error: ok
        ? null
        : stages.find((s) => !s.ok)?.reason ||
          stages.find((s) => !s.ok)?.stderr ||
          stages.find((s) => !s.ok)?.stdout ||
          waveError ||
          "HDL run failed",
      artifacts: {
        result: join(root, "result.json"),
        diagnostics: join(root, "diagnostics.json"),
        ...(waveform
          ? {
              vcd: join(root, "trace.vcd"),
              waveform: join(root, "waveform.json"),
            }
          : {}),
      },
      tui: waveform ? ["chipsim", "--vcd", join(root, "waveform.json")] : null,
    };
    await writeFile(join(root, "diagnostics.json"), jsonText(stages));
    await writeFile(join(root, "result.json"), jsonText(result));
    return { result, waveform };
  });
}
