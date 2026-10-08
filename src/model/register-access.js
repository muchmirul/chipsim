import { validateInputs } from "./stimulus.js";

// Insert/replace one addressed access. Future scheduled accesses retain their
// original address, data, and operation, even when they had held bus fields.
export function registerAccessInputs(
  model,
  inputs,
  { tick, operation, address, value = 0 },
) {
  const bus = model.registerInterface;
  if (!bus)
    throw new Error("This model has no register transaction interface.");
  if (!Number.isInteger(tick) || tick < 1 || tick > 10000)
    throw new Error(
      "Register accesses require tick 1–10000; tick zero establishes the request baseline.",
    );
  if (!["read", "write"].includes(operation))
    throw new Error("Use read or write.");
  const fields = [bus.address, bus.writeData, bus.write, bus.request];
  const original = validateInputs(model.signals, inputs);
  const levels = Object.fromEntries(
    model.signals.map((signal) => [signal.id, signal.initial]),
  );
  const future = [];
  let previous = levels[bus.request],
    before = previous;
  for (let index = 0; index < original.length;) {
    const time = original[index].tick;
    while (index < original.length && original[index].tick === time) {
      const event = original[index++];
      levels[event.signal] = event.value;
    }
    if (time < tick) before = levels[bus.request];
    if (time > tick && levels[bus.request] !== previous)
      future.push({
        tick: time,
        address: levels[bus.address],
        value: levels[bus.writeData],
        write: levels[bus.write],
      });
    previous = levels[bus.request];
  }
  let token = 1 - before;
  const replacements = new Map();
  const key = (event) => `${event.tick}:${event.signal}`;
  const add = (time, addr, data, write) => {
    for (const [signal, v] of [
      [bus.address, addr],
      [bus.writeData, data],
      [bus.write, write],
      [bus.request, token],
    ]) {
      const event = { tick: time, signal, value: v };
      replacements.set(key(event), event);
    }
  };
  add(tick, address, value, operation === "write" ? 1 : 0);
  for (const access of future) {
    token = 1 - token;
    add(access.tick, access.address, access.value, access.write);
  }
  return validateInputs(model.signals, [
    ...original.filter(
      (event) =>
        !replacements.has(key(event)) &&
        !(event.tick === tick && fields.includes(event.signal)) &&
        !(event.tick > tick && event.signal === bus.request),
    ),
    ...replacements.values(),
  ]);
}
