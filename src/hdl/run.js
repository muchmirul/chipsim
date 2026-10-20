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
import { debugTools } from "./debug/tools.js";
import {
  collectDebugRecording,
  failedDebugRecording,
} from "./debug/collector.js";
import { debugLimits, sourceDigest } from "./debug/recording.js";
import { generateEnvironment, environmentSourceName } from "./environment.js";

// No shell, custom commands or loadable simulator plugins in the manifest.
// HDL is executed only by the explicit run action, never by trace import.
export async function processRun(
  command,
  args,
  {
    cwd,
    timeoutMs = 30000,
    signal,
    waveformPath,
    env,
    capturePaths = [],
    owners,
  } = {},
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
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    let registered = Promise.resolve();
    if (owners)
      child.once("spawn", () => {
        registered = (async () => {
          const { processIdentity } = await import("../design/process.js");
          const { atomic } = await import("../design/store.js");
          const owner = await processIdentity(child.pid);
          if (owner) await atomic(join(owners, child.pid + ".json"), owner);
        })().catch((error) =>
          kill("Process ownership failed: " + error.message),
        );
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
    const watched = [
      ...capturePaths,
      ...(waveformPath ? [{ path: waveformPath, limit: limits.bytes }] : []),
    ];
    const watch = watched.length
      ? setInterval(async () => {
          for (const artifact of watched) {
            try {
              if ((await stat(artifact.path)).size > artifact.limit)
                kill("capture artifact exceeds size limit");
            } catch {
              /* not written yet */
            }
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
    child.once("close", async (code, termination) => {
      await registered;
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

export async function hdlDoctor({ debug = false } = {}) {
  if (debug) {
    const toolchain = await debugTools();
    return ["verilog", "vhdl"].map((language) => ({
      language,
      ...toolchain[language],
      root: toolchain.root,
    }));
  }
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
    "environment",
  ]);
  for (const key of Object.keys(project))
    if (!allowed.has(key)) throw new Error("Unknown HDL project field " + key);
  if (
    project.name !== undefined &&
    (typeof project.name !== "string" ||
      !project.name ||
      project.name.length > 2048 ||
      /[\x00-\x1f]/.test(project.name))
  )
    throw new Error("HDL project name must be bounded printable text.");
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
  let environment;
  if (project.environment !== undefined) {
    if (
      project.language !== "verilog" ||
      !["2005-sv", "2009", "2012"].includes(standard)
    )
      throw new Error(
        "Digital environments require Verilog with a SystemVerilog standard.",
      );
    environment = generateEnvironment(project.environment).report.profile;
  }
  return {
    ...project,
    ...(environment ? { environment } : {}),
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
  { signal, onProgress = () => {}, debug = true, owners } = {},
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
        debug,
        owners,
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
    const sources = [],
      debugSources = [];
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
      if (debug) {
        // Assets can be binary. Original HDL/include text is embedded in the
        // portable recording; all copied bytes retain their result fingerprints.
        try {
          const text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
          debugSources.push({
            id: "source:" + name,
            path: name,
            text,
            sha256: sourceDigest(text),
          });
        } catch {
          if (project.sources.includes(name))
            throw new Error("Debug source must be UTF-8: " + name);
        }
      }
    }
    let environment;
    const compileSources = [...project.sources];
    if (project.environment) {
      if (files.size >= 256)
        throw new Error("HDL environment would exceed 256 source/asset files.");
      if (files.has(environmentSourceName))
        throw new Error(
          "The generated environment source name is reserved: " +
            environmentSourceName,
        );
      environment = generateEnvironment(project.environment);
      const bytes = Buffer.from(environment.source);
      total += bytes.length;
      if (bytes.length > 4 * 1048576 || total > 16 * 1048576)
        throw new Error("HDL environment exceeds source snapshot limits.");
      await writeFile(join(sourceRoot, environmentSourceName), bytes, {
        flag: "wx",
      });
      const sha256 = digest(bytes);
      sources.push({
        file: environmentSourceName,
        bytes: bytes.length,
        sha256,
      });
      if (debug)
        debugSources.push({
          id: "source:" + environmentSourceName,
          path: environmentSourceName,
          text: environment.source,
          sha256: sourceDigest(environment.source),
        });
      compileSources.push(environmentSourceName);
      environment.report.generatedSource = {
        file: environmentSourceName,
        sha256,
      };
      await writeFile(
        join(root, "environment.json"),
        jsonText(environment.report),
        { flag: "wx" },
      );
    }
    const { base, ...savedProject } = project;
    await writeFile(join(root, "project.json"), jsonText(savedProject));
    const toolchain = debug ? (await debugTools())[project.language] : null;
    const command = (name) =>
      debug ? toolchain?.commands?.[name] || name : name;
    const captureEnvironment = {
      CHIPSIM_DEBUG_DESIGN: debug ? join(root, "design.jsonl") : undefined,
      CHIPSIM_DEBUG_STREAM: debug ? join(root, "events.jsonl") : undefined,
    };
    const versions = await Promise.all(
      (project.language === "verilog"
        ? [
            ["iverilog", "-V"],
            ["vvp", "-V"],
          ]
        : [["ghdl", "--version"]]
      ).map(([name, flag]) =>
        processRun(command(name), [flag], {
          cwd: sourceRoot,
          signal,
          owners,
          timeoutMs: project.timeoutMs,
          env: {
            CHIPSIM_DEBUG_DESIGN: undefined,
            CHIPSIM_DEBUG_STREAM: undefined,
          },
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
        owners,
        waveformPath: wavePath,
        env: captureEnvironment,
        capturePaths: debug
          ? [
              { path: join(root, "events.jsonl"), limit: 72 * 1048576 },
              { path: join(root, "design.jsonl"), limit: 16 * 1048576 },
            ]
          : [],
      });
      stages.push({ stage: name, ...result });
      return result.ok;
    };
    let ok;
    if (debug && !toolchain.available) {
      stages.push({
        stage: "debug-setup",
        ok: false,
        reason: toolchain.reason,
        stdout: "",
        stderr: "",
      });
      ok = false;
    } else if (project.language === "verilog") {
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
        ...compileSources.map((file) => "./" + file),
      ];
      ok = await execute("compile", command("iverilog"), args);
      if (ok) ok = await execute("simulate", command("vvp"), ["-n", binary]);
    } else {
      ok = await execute("analyze", command("ghdl"), [
        "-a",
        "--std=" + project.standard,
        ...project.sources.map((file) => "./" + file),
      ]);
      if (ok)
        ok = await execute("elaborate", command("ghdl"), [
          "-e",
          "--std=" + project.standard,
          project.top,
        ]);
      if (ok)
        ok = await execute("simulate", command("ghdl"), [
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
    let recording, debugError;
    if (debug) {
      try {
        let design = "";
        if (project.language === "verilog")
          design = (
            await readBounded(join(root, "design.jsonl"), 16 * 1048576)
          ).toString("utf8");
        recording = collectDebugRecording({
          project: savedProject,
          sourceRoot,
          sources: debugSources,
          tools: [
            ...tools,
            {
              instrumentation: toolchain.instrumentation,
              source: toolchain.source,
            },
          ],
          stages,
          design,
          stream: (
            await readBounded(join(root, "events.jsonl"), debugLimits.fileBytes)
          ).toString("utf8"),
        });
      } catch (error) {
        debugError = error.message;
        recording = failedDebugRecording({
          project: savedProject,
          sources: debugSources,
          tools,
          stages,
          reason: debugError,
        });
      }
      await writeFile(
        join(root, "debug.json"),
        JSON.stringify(recording) + "\n",
        { flag: "wx" },
      );
    }
    // Debug testbenches need not contain $dumpvars. A complete structured
    // recording is sufficient; a plain waveform run still requires its VCD.
    ok = Boolean(ok && (debug ? recording?.status.complete : waveform));
    const captureArtifacts = {};
    if (debug)
      for (const [name, file] of [
        ["observer", "events.jsonl"],
        ["design", "design.jsonl"],
      ]) {
        try {
          if ((await lstat(join(root, file))).isFile())
            captureArtifacts[name] = join(root, file);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
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
          debugError ||
          recording?.status.reason ||
          waveError ||
          "HDL run failed",
      artifacts: {
        result: join(root, "result.json"),
        diagnostics: join(root, "diagnostics.json"),
        ...(environment ? { environment: join(root, "environment.json") } : {}),
        ...captureArtifacts,
        ...(recording ? { debug: join(root, "debug.json") } : {}),
        ...(waveform
          ? {
              vcd: join(root, "trace.vcd"),
              waveform: join(root, "waveform.json"),
            }
          : {}),
      },
      tui: recording
        ? ["chipsim", "--hdl-debug", join(root, "debug.json")]
        : waveform
          ? ["chipsim", "--vcd", join(root, "waveform.json")]
          : null,
    };
    await writeFile(join(root, "diagnostics.json"), jsonText(stages));
    await writeFile(join(root, "result.json"), jsonText(result));
    await (
      await import("../design/standalone.js")
    ).inventoryStandalone(root, "hdl", result);
    return { result, waveform, recording };
  });
}
