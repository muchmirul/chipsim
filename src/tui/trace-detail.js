import { display, wrapText } from "./text.js";

function widthOf(model, kind, id) {
  return model[kind]?.find((entry) => entry.id === id)?.width || 32;
}

export function stepReferences(model, snapshot) {
  return (snapshot.evidence || []).flatMap((id) => {
    const evidence = model.evidence?.find((item) => item.id === id),
      source =
        evidence && model.sources.find((item) => item.id === evidence.sourceId);
    return source ? [{ evidence, source }] : [];
  });
}

// Describe only observed adapter status, never infer register effects from
// names, access labels, address bits, or a request token alone.
export function transactionLines(model, snapshot, previous, format) {
  const bus = model.registerInterface;
  if (!bus) return [];
  const signals = snapshot.signals,
    requested =
      previous && signals[bus.request] !== previous.signals[bus.request],
    valid = signals[bus.valid],
    error = signals[bus.error];
  if (!requested && valid !== 1) return [];
  const address = signals[bus.address],
    entry = model.registerMap.find((entry) => entry.address === address),
    operation =
      signals[bus.write] === 1
        ? "Write"
        : signals[bus.write] === 0
          ? "Read"
          : "Unknown operation",
    result =
      error === 1
        ? "rejected"
        : valid === 1 && error === 0
          ? "accepted"
          : "not accepted",
    word = (id) => display(signals[id], format, widthOf(model, "signals", id));
  return [
    "REGISTER TRANSACTION · " + result,
    operation +
      " " +
      display(address, "hex", widthOf(model, "signals", bus.address)) +
      (entry ? " · " + entry.name : " · unmapped address"),
    ...(signals[bus.write] === 1
      ? ["Write data: " + word(bus.writeData)]
      : result === "accepted" && signals[bus.write] === 0
        ? ["Read result: " + word(bus.readData)]
        : ["No accepted read result"]),
    "Adapter status: " +
      bus.valid +
      "=" +
      word(bus.valid) +
      " · " +
      bus.error +
      "=" +
      word(bus.error),
    "",
  ];
}

export function stepLines(state, snapshot) {
  const model = state.model,
    previous = state.trace[snapshot.tick - 1],
    refs = stepReferences(model, snapshot),
    scheduled = state.config.inputs
      .map((event, index) => ({ ...event, index }))
      .filter((event) => event.tick === snapshot.tick);
  return [
    `State: ${snapshot.state} · phase: ${snapshot.phase}`,
    "",
    ...transactionLines(model, snapshot, previous, state.format),
    "EVENT",
    snapshot.message || "No event message at this tick.",
    ...(snapshot.detail && snapshot.detail !== snapshot.message
      ? ["", "DETAIL", snapshot.detail]
      : []),
    "",
    "CHANGES · before → after",
    ...(snapshot.changes.length
      ? snapshot.changes.map((change) => {
          const width = widthOf(model, change.kind, change.id),
            prefix = change.kind === "registers" ? "reg." : "signal.",
            mapped = model.registerMap?.find(
              (entry) => entry.value === prefix + change.id,
            );
          return (
            prefix +
            change.id +
            (mapped ? " · " + mapped.name : "") +
            ": " +
            display(change.before, state.format, width) +
            " → " +
            display(change.after, state.format, width)
          );
        })
      : ["No signal or register values changed."]),
    "",
    "SCHEDULED INPUTS · applied before the model step",
    ...(scheduled.length
      ? scheduled.map((event, index) => {
          const superseded = scheduled
            .slice(index + 1)
            .some((later) => later.signal === event.signal);
          return `#${event.index + 1} ${event.signal} = ${display(event.value, state.format, widthOf(model, "signals", event.signal))}${superseded ? " · superseded at same tick" : ""}`;
        })
      : [
          "No explicit input events at this tick; held/default scenario levels still apply.",
        ]),
    "",
    "SOURCE EVIDENCE · step citations",
    ...(refs.length
      ? refs.flatMap(({ evidence, source }) => [
          `${source.title || source.filename || source.id} · PDF page ${evidence.page}`,
          evidence.claim,
          "“" + evidence.quote + "”",
          "",
        ])
      : [
          "This step has no individual page citation. Model view (5) lists its references and assumptions.",
        ]),
  ];
}

export function detailRows(state, height) {
  const detail = state.traceDetail,
    snapshot = state.trace[detail.tick],
    body = stepLines(state, snapshot).flatMap((text) =>
      wrapText(text, state.columns),
    ),
    capacity = Math.max(1, height - 2);
  detail.scroll = Math.max(0, Math.min(detail.scroll, body.length - capacity));
  return [
    { text: `─ STEP ${detail.tick} · ${state.model.name}`, style: "selected" },
    ...Array.from({ length: capacity }, (_, index) => ({
      text: body[detail.scroll + index] || "",
    })),
    {
      text: `${detail.scroll + 1}–${Math.min(body.length, detail.scroll + capacity)}/${body.length} · j/k scroll · [/] change · F format · s source · Esc close`,
      style: "dim",
    },
  ];
}

export class TraceDetail {
  constructor(app) {
    this.app = app;
  }
  open(snapshot = this.app.state.snapshot) {
    if (!snapshot) return;
    const s = this.app.state;
    s.playing = false;
    s.seek(snapshot.tick);
    s.traceDetail = { tick: snapshot.tick, scroll: 0 };
  }
  sources() {
    const { app } = this,
      s = app.state,
      refs = stepReferences(s.model, s.trace[s.traceDetail.tick]);
    if (!refs.length) {
      s.setMessage(
        "No step-specific citation · close details and use 5 for model references",
      );
      return;
    }
    app.menu(
      "STEP SOURCE EVIDENCE",
      refs.map(({ evidence, source }) => ({
        label: `PDF page ${evidence.page} · ${evidence.id}`,
        detail: evidence.claim + " “" + evidence.quote + "”",
        value: { source, evidence },
      })),
      ({ source, evidence }) => {
        const document = s.documents.find(
          (item) => item.sha256 === source.sha256,
        );
        if (!document) {
          s.setMessage(
            "Cited PDF is not loaded · close details and import its original PDF with d",
            true,
          );
          return;
        }
        s.documentId = document.id;
        s.page = evidence.page;
        s.sourceScroll = 0;
        s.traceDetail = null;
        s.setView("sources");
        s.setMessage("Step citation · " + evidence.claim);
      },
    );
  }
  key(text, key) {
    const s = this.app.state,
      detail = s.traceDetail;
    if (key.name === "escape" || text === "q" || key.name === "return")
      s.traceDetail = null;
    else if (text === "j" || key.name === "down") detail.scroll++;
    else if (text === "k" || key.name === "up")
      detail.scroll = Math.max(0, detail.scroll - 1);
    else if (key.name === "pagedown") detail.scroll += Math.max(1, s.rows - 8);
    else if (key.name === "pageup")
      detail.scroll = Math.max(0, detail.scroll - s.rows + 8);
    else if (text === "0" || key.name === "home") detail.scroll = 0;
    else if (text === "$" || key.name === "end")
      detail.scroll = Number.MAX_SAFE_INTEGER;
    else if (text === "[" || text === "]") {
      s.jumpChange(text === "]" ? 1 : -1);
      detail.tick = s.tick;
      detail.scroll = 0;
    } else if (text === "F") {
      const formats = ["hex", "decimal", "binary", "octal"];
      s.format = formats[(formats.indexOf(s.format) + 1) % formats.length];
    } else if (text === "s") this.sources();
  }
}
