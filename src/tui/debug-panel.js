import {
  debugPanes,
  moveDebugPane,
  followDebugEvent,
  selectDebugObject,
} from "./debug-state.js";
import { debugDetails } from "./debug-render.js";
import { searchBits } from "../hdl/values.js";

const paneForView = { wave: "signals", inspect: "hardware", program: "source" };
export class DebugPanel {
  constructor(app) {
    this.app = app;
  }
  handle(k, key) {
    const app = this.app,
      s = app.state;
    if (k === "I") {
      s.setView("debug");
      return true;
    }
    if (!s.hdlDebug) return false;
    if (k === "J" || k === "N") {
      s.playing = false;
      s.seek(s.tick + (k === "J" ? -1 : 1));
      return true;
    }
    if (k === "K") {
      this.stops();
      return true;
    }
    if (k === "C") {
      s.playing = false;
      if (!s.debugUI.stops.length) {
        this.stops();
        return true;
      }
      const matches = s.debugUI.stops
        .map((stop) => s.hdlDebug.nextMatch(s.tick, stop))
        .filter((v) => v !== null);
      if (matches.length) {
        s.seek(Math.min(...matches));
        s.setMessage("Replay stop matched at event " + s.tick);
      } else
        s.setMessage("No later recorded event matches the configured stops.");
      return true;
    }
    const pane = paneForView[s.view] || s.debugUI.focus;
    if (!["debug", ...Object.keys(paneForView)].includes(s.view)) return false;
    if (key.name === "f2") {
      s.debugUI.focus =
        debugPanes[(debugPanes.indexOf(pane) + 1) % debugPanes.length];
      if (s.view !== "debug")
        s.setView(
          { source: "program", hardware: "inspect", signals: "wave" }[
            s.debugUI.focus
          ],
        );
    } else if (key.name === "f3") {
      if (s.view !== "debug") {
        s.debugUI.focus = pane;
        s.debugUI.maximized = false;
        s.setView("debug");
      } else s.debugUI.maximized = !s.debugUI.maximized;
    } else if (k === "G") {
      s.debugUI.follow = true;
      followDebugEvent(s);
      s.setMessage("Source and hardware follow the selected recorded event.");
    } else if (k === "j" || key.name === "down") moveDebugPane(s, 1, pane);
    else if (k === "k" || key.name === "up") moveDebugPane(s, -1, pane);
    else if (key.name === "return") this.details(pane);
    else return false;
    return true;
  }
  details(pane) {
    const app = this.app,
      s = app.state,
      debug = s.hdlDebug;
    const id = pane === "signals" ? s.signal?.id : s.debugUI.selection;
    const object = debug.objects.get(id);
    const source = debug.sources.get(s.debugUI.sourceFile);
    const items = [
      {
        label: "Current event and selected object",
        detail: debugDetails(s, id),
        value: "close",
      },
      ...(pane === "source" && source
        ? [
            {
              label: `${source.path}:${s.debugUI.sourceLine} · browsed source line`,
              detail: source.text.split("\n")[s.debugUI.sourceLine - 1],
              value: "close",
            },
          ]
        : []),
      ...(pane === "source"
        ? debug.data.sources.map((file) => ({
            label: "Browse source · " + file.path,
            value: { source: file.id },
          }))
        : []),
      { label: "Follow the recorded event in all panes", value: "follow" },
      ...(object?.kind === "instance"
        ? [{ label: "Focus this RTL block", value: "scope" }]
        : []),
      ...(object?.observed
        ? [
            {
              label: s.debugUI.signals.includes(id)
                ? "Unpin signal"
                : "Pin signal",
              value: "pin",
            },
          ]
        : []),
      ...debug
        .related(id)
        .objects.filter((o) => o.id !== id)
        .map((o) => ({
          label: `${o.kind} · ${o.label}`,
          detail: debugDetails(s, o.id),
          value: o.id,
        })),
    ];
    app.menu(
      "HDL DEBUG DETAILS · h/l scroll · static connections ≠ observed execution",
      items,
      (choice) => {
        if (choice?.source) {
          s.debugUI.sourceFile = choice.source;
          s.debugUI.sourceLine = 1;
          s.debugUI.follow = false;
          return;
        }
        if (choice === "close") return;
        if (choice === "follow") {
          s.debugUI.follow = true;
          followDebugEvent(s);
        } else if (choice === "scope") s.debugUI.scope = id;
        else if (choice === "pin") {
          s.debugUI.signals = s.debugUI.signals.includes(id)
            ? s.debugUI.signals.filter((v) => v !== id)
            : [...s.debugUI.signals, id];
        } else selectDebugObject(s, choice);
      },
    );
  }
  stops() {
    const app = this.app,
      s = app.state;
    const kinds = [
      { label: "Add process activation stop", value: "process" },
      { label: "Add signal change stop", value: "change" },
      { label: "Add signal value stop", value: "value" },
      { label: "Add rising edge stop (0 → 1)", value: "rising" },
      { label: "Add falling edge stop (1 → 0)", value: "falling" },
      { label: "Add assertion/report stop", value: "assertion" },
      ...s.debugUI.stops.map((stop, i) => ({
        label: `Remove ${stop.kind} · ${s.hdlDebug.objects.get(stop.object)?.label || "any assertion"}${stop.value ? " = " + stop.value : ""}`,
        value: i,
      })),
      { label: "Clear replay stops", value: "clear" },
    ];
    const add = (stop) => {
      if (s.debugUI.stops.length >= 32)
        throw new Error("At most 32 replay stops.");
      if (
        !s.debugUI.stops.some(
          (value) => JSON.stringify(value) === JSON.stringify(stop),
        )
      )
        s.debugUI.stops.push(stop);
      s.setMessage(
        "Replay stop added · C next match · Space replays until a match",
      );
    };
    app.menu(
      "REPLAY STOPS · conditions inspect this saved run",
      kinds,
      (kind) => {
        if (typeof kind === "number") {
          s.debugUI.stops.splice(kind, 1);
          return;
        }
        if (kind === "clear") {
          s.debugUI.stops = [];
          return;
        }
        if (kind === "assertion") {
          add({ kind });
          return;
        }
        const objects =
          kind === "process"
            ? [...s.hdlDebug.objects.values()].filter(
                (o) => o.kind === "process",
              )
            : s.hdlDebug.signals.filter(
                (o) => !["rising", "falling"].includes(kind) || o.width === 1,
              );
        app.menu(
          "CHOOSE " + (kind === "process" ? "PROCESS" : "SIGNAL"),
          objects.map((o) => ({ label: o.label, value: o })),
          (object) => {
            if (kind === "value")
              app.prompt(
                "Exact signal value (0b/0x/decimal or logic bits)",
                "0",
                (text) =>
                  add({
                    kind,
                    object: object.id,
                    value: searchBits(text, object.width),
                  }),
              );
            else add({ kind, object: object.id });
          },
        );
      },
    );
  }
}
