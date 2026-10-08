import { parsePayload, formatPayload } from "../core/values.js";

const integer = (text) => {
  const parsed = parsePayload(text);
  if (!parsed) throw new Error("Use decimal, 0x, 0b, or 0o whole numbers.");
  return parsed.value;
};

// Prompts only: validation, simulation, rollback, and history belong to state.
export class StimulusEditor {
  constructor(app) {
    this.app = app;
  }
  schedule() {
    const app = this.app,
      state = app.state,
      pins = state.model.signals.filter((s) => s.direction === "input");
    if (!pins.length) {
      state.setMessage("This model has no externally driven inputs.");
      return;
    }
    const preferred = state.stimulus.events()[state.stimulusIndex]?.signal;
    app.menu(
      "SCHEDULE INPUT · choose pin",
      pins.map((pin) => ({ label: pin.label || pin.id, value: pin })),
      (pin) =>
        app.prompt("Event tick · 0–10000", state.tick, (text) => {
          const tick = integer(text);
          if (tick > 10000) throw new Error("Tick must be 0–10000.");
          app.prompt(
            `${pin.label || pin.id} · ${pin.width}-bit scheduled value`,
            formatPayload(
              state.snapshot.signals[pin.id],
              state.format,
              pin.width,
            ),
            (text) => state.stimulus.schedule(pin.id, integer(text), tick),
            {
              help: "Values hold until the pin's next event. An occupied pin/tick is rejected; edit its existing row. U undoes a stimulus change.",
            },
          );
        }),
      Math.max(
        0,
        pins.findIndex((pin) => pin.id === preferred),
      ),
    );
  }
  event() {
    const app = this.app,
      state = app.state,
      event = state.stimulus.events()[state.stimulusIndex];
    if (!event) {
      state.setMessage(
        "No event selected · i schedules an input · a stimulus actions",
      );
      return;
    }
    app.menu(
      `${event.label} · tick ${event.tick}`,
      [
        { label: "Seek waveform at this event", value: "seek" },
        { label: "Edit value", value: "value" },
        { label: "Move to another tick", value: "move" },
        { label: "Remove event · U to undo", value: "remove" },
      ],
      (action) => {
        if (action === "seek") {
          if (event.tick >= state.trace.length)
            throw new Error(
              "This event is outside the current trace; T changes document-model duration.",
            );
          state.seek(event.tick);
          state.setView("wave");
          state.selected = state.model.signals.findIndex(
            (pin) => pin.id === event.signal,
          );
        } else if (action === "remove") state.stimulus.remove(event.index);
        else if (action === "value")
          app.prompt(
            `${event.label} · ${event.width}-bit value at tick ${event.tick}`,
            formatPayload(event.value, state.format, event.width),
            (text) =>
              state.stimulus.edit(event.index, { value: integer(text) }),
          );
        else
          app.prompt("Move event to tick · 0–10000", event.tick, (text) =>
            state.stimulus.edit(event.index, { tick: integer(text) }),
          );
      },
    );
  }
  remove() {
    const state = this.app.state,
      event = state.stimulus.events()[state.stimulusIndex];
    if (!event) throw new Error("No event selected.");
    state.stimulus.remove(event.index);
  }
  actions(loadJSON) {
    const app = this.app,
      state = app.state;
    app.menu(
      "STIMULUS ACTIONS",
      [
        { label: "Schedule an input event", value: "add" },
        { label: "Clear all explicit events · U to undo", value: "clear" },
        { label: "Restore demonstration events · U to undo", value: "restore" },
        { label: "Load JSON array or file", value: "load" },
      ],
      (action) => {
        if (action === "add") this.schedule();
        else if (action === "load") loadJSON();
        else {
          state.stimulus.apply(
            action === "clear" ? [] : state.model.exampleInputs || [],
          );
          state.stimulusIndex = 0;
          state.setMessage(
            action === "clear"
              ? "Explicit stimulus cleared · U to undo"
              : "Demonstration stimulus restored · U to undo",
          );
        }
      },
    );
  }
}
