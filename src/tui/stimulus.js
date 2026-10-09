import { validateInputs } from "../model/stimulus.js";

// Owns atomic input experiments and bounded, model-local undo/redo history.
export class Stimulus {
  constructor(state) {
    this.state = state;
    this.histories = new Map();
  }
  clearHistory(id = this.state.modelId) {
    this.histories.delete(id);
  }
  get history() {
    if (!this.histories.has(this.state.modelId))
      this.histories.set(this.state.modelId, { undo: [], redo: [] });
    return this.histories.get(this.state.modelId);
  }
  configuration() {
    return {
      inputs: structuredClone(this.state.config.inputs),
      duration: this.state.config.duration,
    };
  }
  remember() {
    const history = this.history;
    history.undo.push(this.configuration());
    if (history.undo.length > 20) history.undo.shift();
    history.redo = [];
  }
  apply(
    inputs,
    {
      duration = this.state.config.duration,
      reset = false,
      record = true,
    } = {},
  ) {
    this.state.requireManualExperiment?.();
    if (!Number.isInteger(duration) || duration < 1 || duration > 10000)
      throw new Error("Duration must be 1–10000 ticks.");
    inputs = validateInputs(this.state.model.signals, inputs);
    // Validate and simulate before committing the configuration or history.
    const trace = this.state.model.simulate(this.state.config.parameters, {
      inputs,
      ticks: duration,
    });
    const fault = trace.find((snapshot) => snapshot.phase === "fault");
    if (fault)
      throw new Error(
        `Simulation fault at tick ${fault.tick}: ${fault.detail || fault.message}`,
      );
    const cursor = reset ? 0 : this.state.tick;
    if (
      record &&
      (duration !== this.state.config.duration ||
        JSON.stringify(inputs) !== JSON.stringify(this.state.config.inputs))
    )
      this.remember();
    this.state.config.inputs = inputs;
    this.state.config.duration = duration;
    this.state.trace = trace;
    this.state.playing = false;
    if (reset) this.state.offset = 0;
    this.state.seek(cursor);
  }
  undo(redo = false) {
    const history = this.history,
      from = redo ? history.redo : history.undo,
      to = redo ? history.undo : history.redo,
      previous = from.at(-1);
    if (!previous) {
      this.state.setMessage(
        "No stimulus change to " + (redo ? "redo" : "undo") + ".",
      );
      return;
    }
    const current = this.configuration();
    this.apply(previous.inputs, {
      duration: previous.duration,
      record: false,
    });
    from.pop();
    to.push(current);
    this.state.setMessage(
      "Stimulus " +
        (redo ? "redone" : "undone") +
        " · cursor preserved within trace",
    );
  }
  drive(signalId, value, tick = this.state.tick) {
    if (!Number.isInteger(tick) || tick < 0 || tick >= this.state.trace.length)
      throw new Error("Choose a tick within the current trace.");
    this.apply([
      ...this.state.config.inputs.filter(
        (event) => event.tick !== tick || event.signal !== signalId,
      ),
      { tick, signal: signalId, value },
    ]);
    this.state.setMessage(
      `Input ${signalId}=${value} at tick ${tick} · holds until its next scheduled event`,
    );
  }
  schedule(signal, value, tick) {
    if (
      this.state.config.inputs.some(
        (event) => event.tick === tick && event.signal === signal,
      )
    )
      throw new Error(
        "An event already drives this pin at that tick; edit its row.",
      );
    this.apply([...this.state.config.inputs, { tick, signal, value }], {
      duration:
        this.state.model.kind === "builtin"
          ? this.state.config.duration
          : Math.max(this.state.config.duration, tick),
    });
    this.focus(tick, signal);
    this.state.setMessage(
      `Scheduled ${signal}=${value} at tick ${tick} · U to undo`,
    );
  }
  edit(index, changes) {
    const original = this.event(index),
      event = { ...original, ...changes };
    if (event.signal !== original.signal)
      throw new Error(
        "Event editing preserves its input pin; schedule a different pin instead.",
      );
    if (
      event.tick !== original.tick &&
      this.state.config.inputs.some(
        (other, at) =>
          at !== index &&
          other.tick === event.tick &&
          other.signal === event.signal,
      )
    )
      throw new Error(
        "An event already drives this pin at the destination tick.",
      );
    this.apply(
      this.state.config.inputs.map((input, at) =>
        at === index ? event : input,
      ),
      {
        duration:
          this.state.model.kind === "builtin"
            ? this.state.config.duration
            : Math.max(this.state.config.duration, event.tick),
      },
    );
    this.focus(
      event.tick,
      event.signal,
      event.tick === original.tick ? index : undefined,
    );
    this.state.setMessage(
      `Updated ${event.signal} at tick ${event.tick} · U to undo`,
    );
  }
  event(index) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.state.config.inputs.length
    )
      throw new Error("Choose an existing input event.");
    return this.state.config.inputs[index];
  }
  remove(index) {
    const event = this.event(index);
    this.apply(this.state.config.inputs.filter((_, at) => at !== index));
    this.state.stimulusIndex = Math.max(
      0,
      Math.min(this.state.stimulusIndex, this.events().length - 1),
    );
    this.state.setMessage(
      `Removed ${event.signal} at tick ${event.tick} · U to undo`,
    );
  }
  focus(tick, signal, originalIndex = undefined) {
    const index = this.events().findIndex(
      (event) =>
        event.tick === tick &&
        event.signal === signal &&
        (originalIndex === undefined || event.index === originalIndex),
    );
    if (index >= 0) this.state.stimulusIndex = index;
  }
  events() {
    const next = new Map(),
      pins = new Map(
        this.state.model.signals.map((signal) => [signal.id, signal]),
      ),
      query = this.state.stimulusFilter.toLowerCase();
    return this.state.config.inputs
      .map((event, index) => ({ ...event, index }))
      .toReversed()
      .map((event) => {
        const until = next.get(event.signal);
        next.set(event.signal, event.tick);
        const pin = pins.get(event.signal);
        return {
          ...event,
          label: pin.label || pin.id,
          width: pin.width,
          until,
          superseded: until === event.tick,
          reached: event.tick < this.state.trace.length,
        };
      })
      .toReversed()
      .filter((event) =>
        `${event.signal} ${event.label} ${event.tick}`
          .toLowerCase()
          .includes(query),
      );
  }
}
