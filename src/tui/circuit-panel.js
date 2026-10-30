import { readJSON } from "../agent/io.js";
import { evaluateStep, initialSnapshot } from "../circuit/relation.js";
import { observedStep } from "../circuit/view.js";
import { generatedHDL } from "../circuit/hdl.js";
import { clean, pad, wrapText } from "./text.js";

export function circuitRows(state, height) {
  const connection = state.model.connected;
  if (!connection)
    return [
      {
        text: "Load a connected source/bundle using --circuit or d.",
        style: "",
      },
    ];
  const { model, coverage, ui } = connection,
    lines = [];
  const element = model.state[ui.index % model.state.length];
  lines.push(
    "CONNECTED STATE · t rules · e step · o native · [/] state · p probe",
  );
  lines.push(
    `Coverage: ${coverage.status} · ${model.domainBits} binary domain bits`,
  );
  lines.push(
    `Source SHA ${connection.source.sha256.slice(0, 16)} · ${connection.sourceStatus}`,
  );
  if (["source", "rtl"].includes(ui.tab)) {
    const lowering = connection.report?.lowering;
    lines.push(
      ui.tab === "rtl"
        ? "GENERATED SYSTEMVERILOG · same checked relation"
        : lowering
          ? "AUTHORITATIVE HDL SOURCE · frozen original bytes"
          : "AUTHORITATIVE CONNECTED JSON · frozen original bytes",
    );
    const text =
      ui.tab === "rtl"
        ? generatedHDL(model)
        : Buffer.from(
            lowering?.sourceBytes || connection.sourceBytes,
            "base64",
          ).toString("utf8");
    lines.push(
      ...text
        .split("\n")
        .map((line, index) => `${String(index + 1).padStart(4)} ${line}`),
    );
    return visibleRows(lines, state, height, ui);
  }
  let step;
  if (ui.tab === "native") {
    if (!connection.recorded)
      lines.push("No native observation: run circuit run/verify explicitly.");
    else {
      try {
        const observed = observedStep(state.model, state.trace, state.tick);
        step = observed.step;
        lines.push(
          `NATIVE sample ${state.tick} · ${observed.matches ? "agrees with one-step relation" : observed.harness && step.event === "none" ? "verification state injection" : "RELATION MISMATCH"}`,
        );
        lines.push(
          `Observed Q: ${Object.entries(observed.actual)
            .map(([id, value]) => `${id}=${value}`)
            .join(" ")}`,
        );
        if (observed.harness)
          lines.push(
            "Correspondence harness injects arbitrary states between clock edges.",
          );
      } catch (error) {
        lines.push("Observation inconclusive: " + error.message);
      }
    }
  } else if (ui.tab === "step") {
    step = evaluateStep(model, ui.probe ?? initialSnapshot(model));
    lines.push(
      `ONE-STEP PROBE · ${ui.probe ? "explicit supplied snapshot" : "authored initial snapshot"} · event ${step.event}`,
    );
    lines.push(
      "Probe evaluation does not execute HDL or advance the recording.",
    );
  } else
    lines.push(
      "STATIC RULES · every permitted binary assignment; not trace coverage",
    );
  const update = step?.updates.find((update) => update.state === element.id);
  lines.push(
    `STATE ${element.id} · ${element.width} bit${element.width === 1 ? "" : "s"} · initial ${element.initial}`,
  );
  const mapped = connection.report?.lowering?.mapping?.state?.[element.id];
  if (Array.isArray(mapped?.nets))
    lines.push(
      "HDL retained state: " +
        mapped.nets
          .filter((net) => net && net.visible)
          .map((net) => `${net.name}[${net.index}]`)
          .join(", "),
    );
  if (update) {
    lines.push(`Q ${update.old} -> next Q ${update.next} · ${update.reason}`);
    lines.push(
      `Selected ${update.rule ?? "none"} · priority ${update.priority ?? "none"} · matched ${update.matched.join(",") || "none"}`,
    );
    lines.push(
      `Connected ports: ${Object.entries(update.ports)
        .map(([port, value]) => `${port}=${value}`)
        .join(" ")}`,
    );
    lines.push("Selected guard/data paths (mux follows selected branch):");
    lines.push(
      ...update.selectedDependencies.map(
        (path) => `  ${path.from}[${path.slice.join(":")}] -> ${path.to}`,
      ),
    );
  }
  lines.push("Declared structural paths (all branches remain declared):");
  lines.push(
    ...[...model.connections.values()]
      .filter(
        (link) =>
          ui.tab === "rules" || link.to.startsWith(`state.${element.id}.`),
      )
      .map((link) => `  ${link.from}[${link.slice.join(":")}] -> ${link.to}`),
  );
  if (ui.tab === "rules") {
    lines.push(
      "Rules: higher explicit priority wins; equal-priority winners must agree",
    );
    for (const rule of element.rules)
      lines.push(
        `  ${rule.id} · priority ${rule.priority} · ${rule.reason}`,
        `    when ${JSON.stringify(rule.when, (_, value) => (typeof value === "bigint" ? String(value) : value))}`,
        `    ${rule.hold ? "explicit hold of old Q" : "D = " + JSON.stringify(rule.value, (_, value) => (typeof value === "bigint" ? String(value) : value))}`,
      );
  }
  lines.push(
    "Binary synchronous model only · no physical timing/reachability proof",
  );
  return visibleRows(lines, state, height, ui);
}
function visibleRows(lines, state, height, ui) {
  const wrapped = lines.flatMap((line) => wrapText(clean(line), state.columns));
  ui.scroll = Math.min(ui.scroll, Math.max(0, wrapped.length - height + 1));
  const visible = wrapped.slice(ui.scroll, ui.scroll + height - 1);
  return [
    ...visible.map((line) => pad(clean(line), state.columns)),
    pad(
      "j/k scroll · h/l cursor · t/e/o modes · s source · r RTL · 1 waves",
      state.columns,
    ),
  ].map((text) => ({ text, style: "" }));
}

export function circuitKey(app, key, event) {
  const state = app.state,
    connection = state.model.connected;
  if (!connection || state.view !== "circuit") return false;
  const ui = connection.ui;
  if (["t", "e", "o", "s", "r"].includes(key)) {
    ui.tab = { t: "rules", e: "step", o: "native", s: "source", r: "rtl" }[key];
    ui.scroll = 0;
  } else if (key === "j" || event.name === "down") ui.scroll++;
  else if (key === "k" || event.name === "up")
    ui.scroll = Math.max(0, ui.scroll - 1);
  else if (key === "[" || key === "]") {
    ui.index =
      (ui.index + (key === "[" ? -1 : 1) + connection.model.state.length) %
      connection.model.state.length;
    ui.scroll = 0;
  } else if (key === "p")
    app.prompt(
      "One-step snapshot JSON (state, inputs, previousClock)",
      "",
      (path) =>
        app.task(async () => {
          const snapshot = await readJSON(path, 1048576);
          evaluateStep(connection.model, snapshot);
          ui.probe = snapshot;
          ui.tab = "step";
          ui.scroll = 0;
          state.setMessage(
            "One-step probe loaded; native recording/cursor preserved",
          );
        }),
    );
  else return false;
  return true;
}
