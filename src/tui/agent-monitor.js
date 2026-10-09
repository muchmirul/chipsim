import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  readActivity,
  readPublishedRun,
  digest,
  activityLimit,
} from "../agent/activity.js";
import { loadProject } from "../agent/project.js";
import { readBounded } from "../agent/io.js";
import { activityEvents } from "./activity-panel.js";

// Polling works with atomic file replacement and on platforms without recursive
// fs.watch. Only a completed successful run may replace the inspected session.
export class AgentMonitor {
  constructor(state, project, { onChange = () => {}, interval = 500 } = {}) {
    this.state = state;
    this.project = resolve(project);
    this.onChange = onChange;
    this.interval = interval;
    this.local = [];
    this.localSequence = 0;
    this.modelHashes = new Map();
    this.results = new Map();
    this.rejected = new Set();
    this.waiting = new Set();
    this.loaded = null;
    this.loadedTime = -Infinity;
    this.closed = false;
    this.state.activity = {
      project: this.project,
      enabled: true,
      events: [],
      status: "Waiting for a completed run",
    };
  }
  async initialize() {
    const { document } = await loadProject(this.project);
    this.sourceHash = document.sha256;
    this.attach(document);
    await this.scanModels(true);
    await this.poll();
    return this;
  }
  attach(document) {
    const attached = {
      ...document,
      filePath: join(this.project, "manual.pdf"),
    };
    const index = this.state.documents.findIndex(
      (doc) => doc.sha256 === attached.sha256,
    );
    if (index < 0) this.state.documents.push(attached);
    else this.state.documents[index] = attached;
    this.state.documentId = attached.id;
  }
  start() {
    this.timer = setInterval(() => void this.poll(), this.interval);
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
  toggle() {
    this.state.activity.enabled = !this.state.activity.enabled;
    this.state.activity.status = this.state.activity.enabled
      ? "Watching completed runs"
      : "Run reload paused · activity still live";
    this.onChange();
  }
  add(command, status, message, details = {}, time = new Date().toISOString()) {
    this.local.push({
      id: `monitor-${Date.now()}-${this.localSequence++}`,
      time,
      command,
      status,
      message,
      details,
    });
    this.local = this.local.slice(-activityLimit);
  }
  async scanModels(initial = false) {
    const directory = join(this.project, "models");
    const names = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(0, 500);
    const current = new Map();
    for (const name of names) {
      try {
        const modified = (
          await stat(join(directory, name))
        ).mtime.toISOString();
        const hash = digest(
          await readBounded(join(directory, name), 3 * 1048576),
        );
        current.set(name, hash);
        if (!initial && this.modelHashes.get(name) !== hash)
          this.add(
            "model",
            "changed",
            `${name} ${this.modelHashes.has(name) ? "changed" : "created"} · awaiting check/run`,
            { modelFile: join(directory, name), sha256: hash },
            modified,
          );
      } catch (error) {
        current.set(name, "unreadable:" + error.message);
        if (!initial && this.modelHashes.get(name) !== current.get(name))
          this.add("model", "failed", `${name}: ${error.message}`);
      }
    }
    if (!initial)
      for (const name of this.modelHashes.keys())
        if (!current.has(name)) this.add("model", "removed", `${name} removed`);
    this.modelHashes = current;
  }
  async completedRuns(events) {
    const published = await readPublishedRun(this.project);
    if (published && !events.some((event) => event.id === published.id))
      events = [...events, published];
    const candidates = events
      .filter(
        (event) =>
          ["run", "program-run"].includes(event.command) &&
          event.status === "succeeded" &&
          event.details?.resultFile &&
          event.details?.sessionFile,
      )
      .map((event) => ({
        key: event.id,
        time: Date.parse(event.time),
        ...event.details,
      }));
    // Existing projects/runs created before activity recording remain usable.
    let directories = [];
    try {
      directories = await readdir(join(this.project, "runs"), {
        withFileTypes: true,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const entry of directories
      .filter((entry) => entry.isDirectory())
      .slice(0, 500)) {
      const resultFile = join(this.project, "runs", entry.name, "result.json");
      if (
        candidates.some(
          (candidate) => resolve(candidate.resultFile) === resultFile,
        )
      )
        continue;
      try {
        const info = await stat(resultFile);
        const stamp = `${info.mtimeMs}:${info.size}`;
        let cached = this.results.get(resultFile);
        if (cached?.stamp !== stamp) {
          const bytes = await readBounded(resultFile, 3 * 1048576);
          const result = JSON.parse(bytes);
          cached = { stamp, result, hash: digest(bytes) };
          this.results.set(resultFile, cached);
        }
        if (
          cached.result.ok === true &&
          cached.result.artifacts?.["session.json"]
        )
          candidates.push({
            key: `${resultFile}:${cached.hash}`,
            time: info.mtimeMs,
            resultFile,
            resultSha256: cached.hash,
            sessionFile: cached.result.artifacts["session.json"],
          });
      } catch {
        /* result.json is the last artifact; partial runs stay pending. */
      }
    }
    return candidates.sort(
      (a, b) => b.time - a.time || b.key.localeCompare(a.key),
    );
  }
  poll() {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.update()
      .catch((error) => {
        if (this.closed) return;
        const message = `Watch error: ${error.message}`;
        if (this.state.activity.status !== message)
          this.add("watch", "failed", message);
        this.state.activity.status = message;
        const ids = new Set(
          this.state.activity.events.map((event) => event.id),
        );
        this.state.activity.events = [
          ...this.state.activity.events,
          ...this.local.filter((event) => !ids.has(event.id)),
        ]
          .sort((a, b) => a.time.localeCompare(b.time))
          .slice(-activityLimit);
        if (this.state.activityFollow)
          this.state.activityIndex = Math.max(
            0,
            activityEvents(this.state).length - 1,
          );
      })
      .finally(() => {
        this.pending = null;
        if (!this.closed) this.onChange();
      });
    return this.pending;
  }
  async update() {
    const events = await readActivity(this.project);
    await this.scanModels();
    if (this.state.activity.status.startsWith("Watch error:"))
      this.state.activity.status = this.state.activity.enabled
        ? "Watching completed runs"
        : "Run reload paused · activity still live";
    const previous = activityEvents(this.state)[this.state.activityIndex]?.id;
    this.state.activity.events = [...events, ...this.local]
      .sort((a, b) => a.time.localeCompare(b.time))
      .slice(-activityLimit);
    if (this.state.activityFollow)
      this.state.activityIndex = Math.max(
        0,
        activityEvents(this.state).length - 1,
      );
    else {
      const index = activityEvents(this.state).findIndex(
        (event) => event.id === previous,
      );
      this.state.activityIndex = index < 0 ? 0 : index;
    }
    const candidates = await this.completedRuns(events);
    if (
      !this.state.activity.enabled ||
      this.state.busy ||
      this.state.menu ||
      this.state.prompt ||
      this.state.traceDetail ||
      this.state.help ||
      this.external?.()
    )
      return;
    for (const candidate of candidates) {
      if (candidate.key === this.loaded) break;
      if (
        candidate.time < this.loadedTime ||
        (candidate.time === this.loadedTime &&
          candidate.key.localeCompare(this.loaded || "") < 0)
      )
        continue;
      if (this.rejected.has(candidate.key)) continue;
      try {
        const resultBytes = await readBounded(
          candidate.resultFile,
          3 * 1048576,
        );
        if (digest(resultBytes) !== candidate.resultSha256)
          throw new Error("Completed run result changed");
        const result = JSON.parse(resultBytes);
        for (const name of [
          "trace.json",
          "trace.csv",
          "trace.vcd",
          "session.json",
        ]) {
          if (typeof result.artifacts?.[name] !== "string")
            throw new Error("Run artifacts are incomplete");
          const info = await stat(result.artifacts[name]);
          if (!info.isFile() || !info.size)
            throw Object.assign(new Error("Run artifacts are incomplete"), {
              code: "RUN_PENDING",
            });
        }
        if (
          resolve(result.artifacts["session.json"]) !==
          resolve(candidate.sessionFile)
        )
          throw new Error("Run session path changed");
        const sessionBytes = await readBounded(
          candidate.sessionFile,
          3 * 1048576,
        );
        if (
          candidate.sessionSha256 &&
          digest(sessionBytes) !== candidate.sessionSha256
        )
          throw new Error("Completed run session changed");
        const session = JSON.parse(sessionBytes);
        if (
          result.ok !== true ||
          result.provenance?.sha256 !== this.sourceHash ||
          session.format !== "chipsim-session" ||
          session.modelId !== result.model?.id ||
          !session.model?.sources?.length ||
          session.model.sources.some(
            (source) => source.sha256 !== this.sourceHash,
          )
        )
          throw new Error(
            "Run does not match this project's verified source/model",
          );
        this.state.activity.status = `Verifying completed run ${session.modelId}`;
        this.onChange();
        await loadProject(this.project); // Check the saved cache fingerprint too.
        const { document } = await loadProject(this.project, { fresh: true });
        if (document.sha256 !== this.sourceHash)
          throw new Error("Watched project source changed");
        if (this.closed) return;
        // A prompt or local edit may have started while source verification ran.
        if (
          !this.state.activity.enabled ||
          this.state.busy ||
          this.state.menu ||
          this.state.prompt ||
          this.state.traceDetail ||
          this.state.help ||
          this.external?.()
        )
          return;
        await this.state.loadSession(session, {
          persist: false,
          preserveInspection: true,
          rejectFault: true,
          documents: [
            ...this.state.documents.filter(
              (doc) => doc.sha256 !== document.sha256,
            ),
            { ...document, filePath: join(this.project, "manual.pdf") },
          ],
        });
        this.loaded = candidate.key;
        this.loadedTime = candidate.time;
        this.waiting.delete(candidate.key);
        this.state.activity.status = `Loaded ${session.modelId} · ${session.duration} ticks`;
        this.state.setMessage("Watch: " + this.state.activity.status);
        this.add("watch", "succeeded", this.state.activity.status, {
          sessionFile: candidate.sessionFile,
        });
        break;
      } catch (error) {
        if (["ENOENT", "RUN_PENDING"].includes(error.code)) {
          this.state.activity.status =
            "Waiting for complete run artifacts · kept current simulation";
          if (!this.waiting.has(candidate.key)) {
            this.waiting.add(candidate.key);
            this.add("watch", "progress", this.state.activity.status, {
              sessionFile: candidate.sessionFile,
            });
          }
          continue;
        }
        this.rejected.add(candidate.key);
        this.state.activity.status = `Kept current simulation: ${error.message}`;
        this.add("watch", "failed", this.state.activity.status, {
          sessionFile: candidate.sessionFile,
        });
      }
    }
    this.state.activity.events = [...events, ...this.local]
      .sort((a, b) => a.time.localeCompare(b.time))
      .slice(-activityLimit);
    if (this.state.activityFollow)
      this.state.activityIndex = Math.max(
        0,
        activityEvents(this.state).length - 1,
      );
  }
}
