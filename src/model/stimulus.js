export function validateInputs(signals, inputs) {
  if (!Array.isArray(inputs) || inputs.length > 10000)
    throw new Error("Input events must be an array with at most 10000 entries");
  return inputs
    .map((event) => {
      if (!event || typeof event !== "object")
        throw new Error("Input events must be objects");
      const signal = signals.find(
        (signal) => signal.id === event.signal && signal.direction === "input",
      );
      if (!signal) throw new Error(`Unknown input signal ${event.signal}`);
      if (
        !Number.isSafeInteger(event.tick) ||
        event.tick < 0 ||
        event.tick > 10000
      )
        throw new Error("Input event tick must be between 0 and 10000");
      if (
        !Number.isSafeInteger(event.value) ||
        event.value < 0 ||
        event.value >= 2 ** signal.width
      )
        throw new Error(
          `Invalid ${signal.width}-bit input value for ${signal.id}`,
        );
      return { tick: event.tick, signal: event.signal, value: event.value };
    })
    .sort((a, b) => a.tick - b.tick);
}
