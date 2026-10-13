import { spawn } from "node:child_process";
import { open, readFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { atomic, limits } from "./store.js";

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const text = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return null;
      return { pid, start: fields[19] };
    }
    return { pid, start: null };
  } catch {
    return null;
  }
}
export async function alive(owner) {
  const current = owner && (await processIdentity(owner.pid));
  return !!current && current.start === owner.start;
}
export async function stopOwned(owner, signal = "SIGTERM") {
  if (!(await alive(owner))) return;
  try {
    process.kill(process.platform === "win32" ? owner.pid : -owner.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
export async function reapToken(token) {
  if (!token || process.platform !== "linux") return;
  const marker = Buffer.from("CHIPSIM_JOB_TOKEN=" + token + "\0");
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const owner = await processIdentity(Number(name));
      if (
        owner &&
        (await readFile(`/proc/${name}/environ`)).includes(marker) &&
        (await alive(owner))
      )
        process.kill(owner.pid, "SIGKILL");
    } catch {
      /* process exited or belongs to another user */
    }
  }
}

export async function execute(
  command,
  args,
  { cwd, signal, timeoutMs = 3600000, env = {}, log, owners } = {},
) {
  if (signal?.aborted) return { ok: false, reason: "cancelled", code: null };
  await mkdir(dirname(log), { recursive: true });
  const output = await open(log, "a");
  let bytes = (await output.stat()).size,
    reason,
    owner,
    timer,
    killer,
    ownershipError;
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const kill = (why) => {
    reason ||= why;
    try {
      if (child.pid)
        process.kill(
          process.platform === "win32" ? child.pid : -child.pid,
          "SIGTERM",
        );
    } catch {}
    killer ||= setTimeout(() => {
      try {
        if (child.pid)
          process.kill(
            process.platform === "win32" ? child.pid : -child.pid,
            "SIGKILL",
          );
      } catch {}
    }, 500);
  };
  const abort = () => kill("cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let writes = Promise.resolve();
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limits.log) {
        kill("log limit exceeded");
        return;
      }
      stream.pause();
      writes = writes
        .then(() => output.write(chunk))
        .catch((error) => {
          reason ||= error.message;
          kill("log write failed");
        })
        .finally(() => stream.resume());
    });
  const registered = new Promise((done) => {
    child.once("spawn", async () => {
      try {
        owner = await processIdentity(child.pid);
        if (owners && owner)
          await atomic(join(owners, child.pid + ".json"), {
            ...owner,
            command,
            args,
          });
      } catch (error) {
        ownershipError = error.message;
        kill("cannot register child ownership");
      }
      done();
    });
    child.once("error", (error) => {
      reason ||= error.message;
      done();
    });
  });
  timer = setTimeout(() => kill("timeout"), timeoutMs);
  const result = await new Promise((done) =>
    child.once("close", (code, termination) =>
      done({ code, signal: termination }),
    ),
  );
  await registered;
  clearTimeout(timer);
  // Retain the escalation timer after cancellation: grandchildren may still run.
  if (reason && killer) await new Promise((done) => setTimeout(done, 550));
  clearTimeout(killer);
  signal?.removeEventListener("abort", abort);
  await writes;
  await output.close();
  return {
    command,
    args,
    ...result,
    ok: result.code === 0 && !reason,
    reason: reason || ownershipError || null,
  };
}
