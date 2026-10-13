import {
  access,
  readFile,
  writeFile,
  mkdir,
  realpath,
  lstat,
  readdir,
  readlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import {
  resolve,
  dirname,
  join,
  basename,
  delimiter,
  relative,
  isAbsolute,
} from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { designGuidance } from "./guide.js";
import {
  Store,
  json,
  files,
  fileDigest,
  identity,
  localPath,
  limits,
} from "./store.js";
import {
  adapterInputs,
  adapterResources,
  adapterIdentity,
  adapters,
} from "./adapters.js";
import { validatePhysicalReports } from "./physical.js";

export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export function name(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw new Error("Invalid project/task/target name: " + value);
  return value;
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be an object");
}
export async function loadDesign(path) {
  const file = resolve(
    path.endsWith(".json") ? path : join(path, "chipsim.design.json"),
  );
  const config = await json(file, 1048576);
  if (config.format !== "chipsim-design" || config.version !== 1)
    throw new Error("Expected chipsim-design version 1");
  name(config.id);
  object(config.tasks, "tasks");
  object(config.targets, "targets");
  if (
    Object.keys(config.tasks).length > 256 ||
    !Object.keys(config.targets).length
  )
    throw new Error("Expected 1–256 tasks and at least one target");
  for (const [id, task] of Object.entries(config.tasks)) {
    name(id);
    object(task, "task");
    if (!adapters[task.adapter])
      throw new Error("Unknown adapter: " + task.adapter);
    for (const key of [
      "inputs",
      "filesets",
      "needs",
      "bindings",
      "outputs",
      "checks",
    ])
      if (
        task[key] !== undefined &&
        (!Array.isArray(task[key]) || task[key].length > 512)
      )
        throw new Error(id + "." + key + " requires a bounded array");
    for (const path of task.inputs || []) localPath(path);
    for (const binding of task.bindings || []) {
      name(binding.task);
      localPath(binding.output);
      localPath(binding.path);
    }
    for (const output of task.outputs || []) {
      localPath(output.path);
      if (typeof output.kind !== "string")
        throw new Error("Output requires kind");
    }
    if (
      new Set((task.outputs || []).map((o) => o.path)).size !==
      (task.outputs || []).length
    )
      throw new Error("Duplicate output path");
    if (
      new Set((task.bindings || []).map((b) => b.path)).size !==
      (task.bindings || []).length
    )
      throw new Error("Duplicate binding destination");
    const checkNames = new Set([
      "execution",
      "outputs",
      "tests",
      "simulation",
      "formal",
      "equivalence",
      "import",
      "preparation",
      "comparison",
      "mcp",
    ]);
    for (const check of task.checks || []) {
      name(check.name);
      localPath(check.path);
      if (checkNames.has(check.name))
        throw new Error("Duplicate/reserved check name " + check.name);
      checkNames.add(check.name);
      if (
        !["eq", "lte", "gte"].includes(check.operator) ||
        typeof check.field !== "string" ||
        !check.field ||
        !Object.hasOwn(check, "value")
      )
        throw new Error("Check requires field, operator and value");
    }
    if (task.options !== undefined) object(task.options, "options");
    validatePhysicalReports(task);
    if (
      task.timeoutMs !== undefined &&
      (!Number.isSafeInteger(task.timeoutMs) ||
        task.timeoutMs < 100 ||
        task.timeoutMs > 86400000)
    )
      throw new Error("timeoutMs must be 100–86400000");
  }
  for (const [id, target] of Object.entries(config.targets)) {
    name(id);
    object(target, "target");
    if (!Array.isArray(target.tasks) || !target.tasks.length)
      throw new Error("Target requires tasks");
    if (
      !Array.isArray(target.requiredChecks || []) ||
      (target.requiredChecks || []).some(
        (c) =>
          typeof c !== "string" || !/^[A-Za-z][\w.-]*:[A-Za-z][\w.-]*$/.test(c),
      )
    )
      throw new Error("requiredChecks must be an array of TASK:CHECK names");
  }
  const root = dirname(file);
  const lock = await json(join(root, "chipsim.lock.json"), 1048576);
  if (lock.format !== "chipsim-lock" || lock.version !== 1)
    throw new Error("Expected chipsim-lock version 1");
  return { root, file, config, lock, store: new Store(root) };
}
export async function initDesign(path) {
  const root = resolve(path);
  await mkdir(root, { recursive: true });
  const config = {
    format: "chipsim-design",
    version: 1,
    id: "design",
    name: basename(root),
    filesets: {},
    tools: {},
    tasks: {
      simulate: { adapter: "hdl", options: { project: "sim.project.json" } },
    },
    targets: {
      simulation: {
        tasks: ["simulate"],
        requiredChecks: ["simulate:simulation"],
      },
    },
  };
  // Reserve both names before writing either; never replace a user's project.
  const { open, unlink } = await import("node:fs/promises");
  const design = await open(join(root, "chipsim.design.json"), "wx");
  let lock;
  try {
    lock = await open(join(root, "chipsim.lock.json"), "wx");
  } catch (error) {
    await design.close();
    await unlink(join(root, "chipsim.design.json"));
    throw error;
  }
  try {
    await design.writeFile(JSON.stringify(config, null, 2) + "\n");
    await lock.writeFile(
      JSON.stringify(
        { format: "chipsim-lock", version: 1, dependencies: [] },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await design.close();
    await lock.close();
  }
  return {
    project: root,
    manifest: join(root, "chipsim.design.json"),
    guidance: designGuidance(),
    next:
      "Prepare sim.project.json plus RTL and a testbench (design guide rtl describes a runnable starter), declare any other inputs/tool profiles, then run chipsim design doctor --project " +
      root,
  };
}
export function orderTasks(config, target) {
  const entry = config.targets[target];
  if (!entry) throw new Error("Unknown target: " + target);
  const result = [],
    visiting = new Set(),
    visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error("Task dependency cycle at " + id);
    if (visited.has(id)) return;
    const task = config.tasks[id];
    if (!task) throw new Error("Missing task: " + id);
    visiting.add(id);
    for (const dependency of new Set([
      ...(task.needs || []),
      ...(task.bindings || []).map((b) => b.task),
    ]))
      visit(dependency);
    visiting.delete(id);
    visited.add(id);
    result.push(id);
  }
  entry.tasks.forEach(visit);
  return result;
}
export async function executable(command) {
  for (const path of command.includes("/")
    ? [resolve(command)]
    : (process.env.PATH || "")
        .split(delimiter)
        .filter(Boolean)
        .map((p) => join(p, command))) {
    // Keep the invocation path: resolving a virtualenv's Python symlink changes
    // sys.prefix and loses the installed EDA packages. Hashing follows the link.
    try {
      await access(path, constants.X_OK);
      return resolve(path);
    } catch {}
  }
  return null;
}
export async function toolIdentity(
  command,
  versionArgs = ["--version"],
  { probe = true, known = [] } = {},
) {
  const path = await executable(command);
  if (!path) return { command, versionArgs, available: false, version: null };
  const digest = await fileDigest(path);
  if (!probe) {
    const previous = known.find(
      (t) =>
        t.command === command &&
        t.path === path &&
        t.sha256 === digest.sha256 &&
        identity(t.versionArgs) === identity(versionArgs),
    );
    return {
      command,
      versionArgs,
      path,
      available: true,
      ...digest,
      version: previous?.version || "not probed",
    };
  }
  let version;
  try {
    const out = await promisify(execFile)(path, versionArgs, {
      timeout: 5000,
      maxBuffer: 65536,
    });
    version = (out.stdout + out.stderr).trim().slice(0, 4096);
  } catch (error) {
    version =
      (String(error.stdout || "") + String(error.stderr || ""))
        .trim()
        .slice(0, 4096) || "version unavailable";
  }
  return { command, versionArgs, path, available: true, ...digest, version };
}
export async function runtimeIdentity() {
  const entries = [];
  for (const path of await files(packageRoot, [
    "src",
    "scripts",
    "extensions",
    "package.json",
    "docs/references/manifest.json",
    "docs/references/catalog.json",
  ]))
    entries.push({ path, ...(await fileDigest(join(packageRoot, path))) });
  return {
    sha256: identity(entries),
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
}
export async function dependencyIdentity(path) {
  const root = await realpath(path);
  const records = [];
  const excluded = new Set([".git", ".chipsim"]);
  async function visit(entry) {
    const full = join(root, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      const target = relative(root, await realpath(full));
      if (
        target === ".." ||
        target.startsWith("../") ||
        isAbsolute(target) ||
        target.split("/").some((p) => excluded.has(p))
      )
        throw new Error(
          "Locked dependency symbolic link escapes its inventory: " + entry,
        );
      records.push({ path: entry, link: await readlink(full) });
    } else if (info.isDirectory()) {
      for (const name of (await readdir(full)).sort())
        if (!excluded.has(name)) await visit(join(entry, name));
    } else if (info.isFile()) {
      records.push({ path: entry, ...(await fileDigest(full)) });
    } else
      throw new Error("Locked dependency must contain regular files: " + entry);
    if (records.length > limits.files)
      throw new Error("Locked dependency file count exceeds limit");
  }
  await visit("");
  return identity(records);
}
export async function verifyDependencies(dependencies, root) {
  for (const dependency of dependencies) {
    if (!dependency.path || !/^[a-f0-9]{64}$/.test(dependency.sha256))
      throw new Error("Locked dependency requires path and sha256");
    if (
      (await dependencyIdentity(resolve(root, dependency.path))) !==
      dependency.sha256
    )
      throw new Error("Locked dependency changed: " + dependency.path);
  }
}
export async function planDesign(
  path,
  target,
  { capture = true, probe = true } = {},
) {
  const design = await loadDesign(path),
    { config, lock, root, store } = design;
  const order = orderTasks(config, target),
    taskPlans = [],
    all = new Map();
  const runtime = await runtimeIdentity();
  const toolCache = new Map();
  const known = probe
    ? []
    : (await store.list("execution-plan")).flatMap((p) =>
        p.tasks.flatMap((t) => t.tools),
      );
  for (const id of order) {
    const task = config.tasks[id],
      adapter = adapters[task.adapter];
    const profile = task.tool ? config.tools?.[task.tool] : {};
    if (!profile) throw new Error("Unknown tool profile " + task.tool);
    const paths = [...(task.inputs || [])];
    for (const set of task.filesets || []) {
      if (!Array.isArray(config.filesets?.[set]))
        throw new Error("Unknown fileset " + set);
      paths.push(...config.filesets[set].map(localPath));
    }
    paths.push(...(await adapterInputs(task, root)));
    const inputs = [];
    for (const path of await files(root, [...new Set(paths)])) {
      if (!all.has(path))
        all.set(path, {
          path,
          ...(await (capture
            ? store.putFile(join(root, path))
            : fileDigest(join(root, path)))),
        });
      inputs.push(all.get(path));
    }
    for (const resource of await adapterResources(task, root)) {
      if (!all.has(resource.path))
        all.set(resource.path, {
          path: resource.path,
          ...(await (capture
            ? store.putFile(resource.origin)
            : fileDigest(resource.origin))),
        });
      inputs.push(all.get(resource.path));
    }
    for (const binding of task.bindings || [])
      if (inputs.some((i) => i.path === binding.path))
        throw new Error("Binding overwrites source input " + binding.path);
    const commandOverride = profile.command || task.options?.command;
    const commands = commandOverride
      ? [
          [
            commandOverride,
            profile.versionArgs || task.options?.versionArgs || ["--version"],
          ],
        ]
      : await adapter.tools(task, root);
    const tools = [];
    for (const [command, args] of commands) {
      const key = identity({ command, args });
      if (!toolCache.has(key))
        toolCache.set(key, await toolIdentity(command, args, { probe, known }));
      tools.push(toolCache.get(key));
    }
    const dependencies = (lock.dependencies || []).filter(
      (dep) => !dep.tasks || dep.tasks.includes(id),
    );
    await verifyDependencies(dependencies, root);
    const base = {
      task: id,
      definition: task,
      profile,
      inputs,
      tools,
      dependencies,
      runtime,
      backend: await adapterIdentity(task),
    };
    taskPlans.push({
      ...base,
      fingerprint: identity(base),
      needs: [
        ...new Set([
          ...(task.needs || []),
          ...(task.bindings || []).map((b) => b.task),
        ]),
      ],
    });
  }
  const snapshotBody = {
    projectId: config.id,
    config,
    lock,
    inputs: [...all.values()],
    runtime,
  };
  const snapshot = capture
    ? await store.put("input-snapshot", snapshotBody)
    : { ...snapshotBody, id: identity(snapshotBody) };
  const body = {
    projectId: config.id,
    target,
    policy: config.targets[target],
    snapshot: snapshot.id,
    tasks: taskPlans,
  };
  const plan = capture ? await store.put("execution-plan", body) : body;
  return { ...design, snapshot, plan };
}
