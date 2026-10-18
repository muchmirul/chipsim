import { resolve } from "node:path";
import { listWork, workStatus } from "../agent/work.js";
import { Store } from "../design/store.js";
import { jobLogs, jobStatus } from "../design/jobs.js";
import { verifyEvidence } from "../design/evidence.js";
import { openRecordedArtifact } from "./design-panel.js";
import { clean, wrapText } from "./text.js";

const row = (text, style = "") => ({ text: clean(text), style });
const eventLimit = 200;
const logLimit = 256 * 1024;
const short = (id) => (id || "—").slice(0, 12);
const metrics = (values = {}) =>
  Object.entries(values)
    .map(([name, metric]) => `${name}=${metric.value} ${metric.unit}`)
    .join(" · ");
export function workItems(state) {
  const w = state.work;
  if (!w) return [];
  const items = w.tab === "candidates" ? w.candidates : w.events;
  return items.filter(
    (item) =>
      !w.filter ||
      JSON.stringify(item).toLowerCase().includes(w.filter.toLowerCase()),
  );
}
function selectedItem(state) {
  const w = state.work,
    items = workItems(state);
  return items.find((item) => item.id === w.selection[w.tab]) || items[0];
}
function jobText(job) {
  return (
    `${job.state} · ${job.target} · ${short(job.id)} · ` +
    Object.entries(job.tasks || {})
      .map(([name, task]) => `${name}:${task.state}`)
      .join(" ")
  );
}
export function workRows(state, height) {
  const w = state.work;
  if (!w) return [];
  if (w.detail) {
    const d = w.detail,
      lines = wrapText(d.text, state.columns);
    const count = Math.max(1, height - 3);
    d.scroll = d.follow
      ? Math.max(0, lines.length - count)
      : Math.max(0, Math.min(d.scroll, Math.max(0, lines.length - count)));
    return [
      row(d.title, "selected"),
      row(
        d.error ||
          (d.type === "job"
            ? `LIVE managed-job log · ${d.follow ? "following" : "browsing"} · ${d.project}`
            : "Agent-reported unless marked verified evidence"),
        d.error ? "error" : "dim",
      ),
      ...lines.slice(d.scroll, d.scroll + count).map((text) => row(text)),
      row("Esc back · j/k scroll · G follow log · o evidence", "dim"),
    ].slice(0, height);
  }
  const items = workItems(state),
    selected = selectedItem(state);
  const jobs = state.design?.summary.jobs || [];
  const running = jobs.find((job) =>
    ["accepted", "queued", "running"].includes(job.state),
  );
  const headers = [
    row(w.project, "dim"),
    row(
      w.session
        ? `Session ${short(w.session.id)} · ${w.session.mode} · ${w.session.status} · agent-reported`
        : "No agent-work sessions yet",
      "selected",
    ),
    ...wrapText(
      `Goal: ${w.session?.goal || "Publish explicit progress with chipsim agent work-start / work-event"}`,
      state.columns,
    )
      .slice(0, 2)
      .map((text) => row(text)),
    row(
      `${w.sessions.length} sessions · ${w.candidates.length} candidates · ${w.events.length}/${w.totalEvents} recent events · ${w.status}`,
      "dim",
    ),
    ...(jobs.length
      ? [row("Managed job: " + jobText(running || jobs[0]), "dim")]
      : []),
    row(
      `${w.tab === "candidates" ? "CANDIDATES" : "EVENTS"} · agent-reported status / metrics${w.filter ? " · filter: " + w.filter : ""}`,
      "selected",
    ),
  ];
  const count = Math.max(1, height - headers.length - 2);
  const index = Math.max(0, items.indexOf(selected));
  const first = Math.max(0, index - Math.floor(count / 2));
  return [
    ...headers,
    ...(items.length
      ? items
          .slice(first, first + count)
          .map((item) =>
            row(
              (item === selected ? "› " : "  ") +
                (w.tab === "candidates"
                  ? `${short(item.id)} · ${item.status || "reported"} · ${metrics(item.metrics)} · gen ${item.generation ?? "—"} ← ${item.parent ? short(item.parent) : "root"} · ${item.message}`
                  : `${item.time.slice(11, 19)} ${item.kind} ${item.status || ""} · ${item.candidate ? short(item.candidate) + " " : ""}${item.message}`),
              item === selected
                ? "selected"
                : item.status === "failed"
                  ? "error"
                  : "",
            ),
          )
      : [
          row(
            "No reported " +
              w.tab +
              ". No agent or tool is started by this view.",
          ),
        ]),
    row(
      "s sessions · c candidates / e events · j/k select · / filter · G follow",
      "dim",
    ),
    row(
      "Enter full detail · o evidence · L job logs · g goal · r refresh",
      "dim",
    ),
  ].slice(0, height);
}

export class WorkPanel {
  constructor(state, project, { onChange = () => {}, interval = 500 } = {}) {
    this.state = state;
    this.project = resolve(project);
    this.onChange = onChange;
    this.interval = interval;
    this.closed = false;
    state.work = {
      project: this.project,
      sessions: [],
      session: null,
      sessionId: null,
      events: [],
      candidates: [],
      totalEvents: 0,
      tab: "events",
      selection: {},
      filter: "",
      follow: true,
      detail: null,
      status: "Waiting for reported work",
    };
  }
  async initialize() {
    await this.update();
    return this;
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      const s = this.state;
      if (
        !s.busy &&
        !s.prompt &&
        !s.menu &&
        !s.help &&
        !s.traceDetail &&
        !this.external?.()
      )
        void this.refresh();
    }, this.interval);
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
  refresh() {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.update()
      .catch((error) => {
        if (!this.closed) {
          this.state.work.status = "Read error: " + error.message;
          if (this.state.work.detail?.type === "job")
            this.state.work.detail.error = this.state.work.status;
        }
      })
      .finally(() => {
        this.pending = null;
        if (!this.closed) this.onChange?.();
      });
    return this.pending;
  }
  async update() {
    const w = this.state.work,
      requested = w.sessionId;
    const sessions = await listWork(this.project);
    const sessionId = requested || sessions[0]?.id;
    const status = await workStatus(this.project, {
      session: sessionId,
      limit: eventLimit,
    });
    if (this.closed || requested !== w.sessionId) return;
    Object.assign(w, status, {
      sessions,
      sessionId: status.session?.id || null,
      status: "Live · explicit reports only",
    });
    for (const tab of ["events", "candidates"]) {
      const items = w[tab];
      if (w.follow && tab === w.tab)
        w.selection[tab] = workItems(this.state).at(-1)?.id;
      else if (!items.some((item) => item.id === w.selection[tab]))
        w.selection[tab] = items[0]?.id;
    }
    const detail = w.detail;
    if (detail?.type === "job") await this.refreshLog(detail);
  }
  detail(title, data, evidence = null) {
    this.state.work.detail = {
      title,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      evidence,
      scroll: 0,
      follow: false,
    };
  }
  async refreshLog(detail) {
    const store = new Store(detail.project);
    const [job, log] = await Promise.all([
      jobStatus(store, detail.id),
      jobLogs(store, detail.id, { offset: detail.cursor }),
    ]);
    if (this.closed || this.state.work.detail !== detail) return;
    detail.error = null;
    detail.cursor = log.cursor;
    detail.log += log.text;
    if (detail.log.length > logLimit) {
      detail.log = detail.log.slice(-logLimit);
      detail.trimmed = true;
    }
    detail.text =
      `Managed job: ${jobText(job)}
` +
      (job.error
        ? `Error: ${job.error}
`
        : "") +
      (detail.trimmed
        ? "Earlier log text omitted from the bounded live view.\n"
        : "") +
      (detail.log || "Waiting for tool output…") +
      (log.nextOffset !== null ? "\nMore output will load on refresh." : "");
    detail.evidence = {
      project: detail.project,
      job: detail.id,
      ...(job.run ? { run: job.run } : {}),
    };
  }
  async openLog(project, id) {
    const detail = {
      type: "job",
      project,
      id,
      title: "JOB LOG · " + id,
      text: "Loading managed-job output…",
      log: "",
      cursor: 0,
      scroll: 0,
      follow: true,
    };
    this.state.work.detail = detail;
    await this.refreshLog(detail);
  }
  async openRecord(project, id) {
    const { data, opened } = await openRecordedArtifact(
      this.state,
      new Store(project),
      id,
    );
    if (!opened)
      this.detail(
        "VERIFIED EVIDENCE · " + id,
        { project, ...data },
        { project, ...(data.artifact ? { artifact: id } : { run: id }) },
      );
    else
      this.state.setMessage(
        "Verified recorded artifact · " + project + " · " + short(id),
      );
  }
  async evidenceMenu(evidence, app) {
    if (!evidence)
      throw new Error("No evidence links were reported for this item.");
    const project = resolve(this.project, evidence.project || ".");
    const store = new Store(project),
      entries = [],
      seen = new Set();
    const references = [];
    if (evidence.job) {
      const job = await jobStatus(store, evidence.job);
      entries.push({
        label: "LIVE JOB LOG · " + jobText(job),
        value: { job: job.id },
      });
      if (job.run) references.push(job.run);
    }
    references.push(evidence.run, evidence.artifact);
    const roots = [];
    for (const id of references.filter(Boolean)) {
      if (seen.has(id)) continue;
      seen.add(id);
      roots.push(await verifyEvidence(store, id));
    }
    const linked = [...roots];
    for (const record of roots) {
      for (const id of [
        ...(record.checks || []),
        ...(record.artifacts || []),
        ...(record.evidence || []),
      ]) {
        if (seen.has(id)) continue;
        if (linked.length >= 200) break;
        seen.add(id);
        linked.push(await verifyEvidence(store, id));
      }
    }
    for (const record of linked)
      entries.push({
        label: `${record.format.slice(8)} · ${record.path || record.name || short(record.id)}${record.verdict ? " · " + record.verdict : ""}`,
        detail: `Verified stored record in ${project}\n${record.id}`,
        value: { id: record.id },
      });
    if (linked.length >= 200)
      entries.push({
        label:
          "First 200 records shown · open a record for its linked evidence",
        value: null,
      });
    if (!entries.length)
      throw new Error(
        "The report names a project but contains no job, run or artifact link.",
      );
    app.menu(
      "EVIDENCE · " + project,
      entries,
      (choice) =>
        choice &&
        app.task(() =>
          choice.job
            ? this.openLog(project, choice.job)
            : this.openRecord(project, choice.id),
        ),
    );
  }
  logsMenu(app) {
    const evidence =
      this.state.work.detail?.evidence || selectedItem(this.state)?.evidence;
    if (evidence?.job) {
      app.task(() =>
        this.openLog(
          resolve(this.project, evidence.project || "."),
          evidence.job,
        ),
      );
      return;
    }
    const jobs = this.state.design?.summary.jobs || [];
    if (!jobs.length)
      throw new Error(
        "Select a reported job link, or open a design with managed jobs.",
      );
    app.menu(
      "MANAGED JOB LOGS",
      jobs.map((job) => ({ label: jobText(job), value: job.id })),
      (id) => app.task(() => this.openLog(this.state.design.root, id)),
    );
  }
  handle(k, key, app) {
    const s = this.state,
      w = s.work;
    if (!w || s.view !== "activity") return false;
    const detail = w.detail;
    if (detail) {
      if (key.name === "escape") w.detail = null;
      else if (["j", "down", "k", "up"].includes(k)) {
        detail.follow = false;
        detail.scroll = Math.max(
          0,
          detail.scroll + (["j", "down"].includes(k) ? 1 : -1),
        );
      } else if (k === "G" && detail.type === "job") detail.follow = true;
      else if (k === "L") this.logsMenu(app);
      else if (k === "o")
        app.task(() => this.evidenceMenu(detail.evidence, app));
      else if (k === "r") app.task(() => this.refresh());
      else return false;
      return true;
    }
    if (["j", "down", "k", "up"].includes(k)) {
      const items = workItems(s),
        index = Math.max(0, items.indexOf(selectedItem(s)));
      w.selection[w.tab] =
        items[
          Math.max(
            0,
            Math.min(
              items.length - 1,
              index + (["j", "down"].includes(k) ? 1 : -1),
            ),
          )
        ]?.id;
      w.follow = false;
    } else if (k === "c" || k === "e")
      w.tab = k === "c" ? "candidates" : "events";
    else if (k === "G") {
      w.follow = true;
      w.selection[w.tab] = workItems(s).at(-1)?.id;
    } else if (k === "/")
      app.prompt(
        "Filter reported work",
        w.filter,
        (text) => {
          w.filter = text;
        },
        { allowEmpty: true },
      );
    else if (k === "s")
      app.menu(
        "AGENT-WORK SESSIONS",
        w.sessions.length
          ? w.sessions.map((session) => ({
              label: `${short(session.id)} · ${session.mode} · ${session.goal}`,
              detail: `${session.id}
${session.createdAt}
${session.goal}`,
              value: session.id,
            }))
          : [{ label: "No reported sessions", value: null }],
        (id) => {
          if (id) {
            w.sessionId = id;
            w.selection = {};
            w.detail = null;
            app.task(() => this.refresh());
          }
        },
      );
    else if (k === "g")
      this.detail(
        "AGENT-REPORTED SESSION",
        w.session || { project: w.project },
      );
    else if (k === "r") app.task(() => this.refresh());
    else if (k === "L") this.logsMenu(app);
    else if (k === "o")
      app.task(() => this.evidenceMenu(selectedItem(s)?.evidence, app));
    else if (key.name === "return") {
      const item = selectedItem(s);
      this.detail(
        "AGENT-REPORTED " + (w.tab === "candidates" ? "CANDIDATE" : "EVENT"),
        item || w.session,
        item?.evidence,
      );
    } else return false;
    return true;
  }
}
