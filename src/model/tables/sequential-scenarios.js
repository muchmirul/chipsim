import { bits, nextOutputs } from "./sequential-read.js";
import { pinId } from "./shared.js";
import { input } from "../builders/shared.js";
export function sequentialScenarios(table, instances, shared) {
  const count = table.inputs.length,
    outCount = table.outputs.length;
  // Emit shared inputs once; rotate private data without rotating the clock.
  const events = (values, tick, rotate = true) => {
    const inputs = [],
      vectors = [];
    instances.forEach((instance, index) => {
      const vector = [...values];
      const privateBits = table.inputs
        .map((label, bit) => ({ label, bit }))
        .filter(
          ({ label, bit }) =>
            !shared.includes(label) && bit !== table.clock.index,
        );
      let data = privateBits.reduce(
        (value, { bit }) => (value << 1) | values[bit],
        0,
      );
      data = (data + (rotate ? index : 0)) % 2 ** privateBits.length;
      privateBits.forEach(
        ({ bit }, offset) =>
          (vector[bit] = (data >> (privateBits.length - 1 - offset)) & 1),
      );
      vector.forEach((value, bit) => {
        if (
          !inputs.some((event) => event.signal === pinId(instance.labels[bit]))
        )
          inputs.push(input(tick, pinId(instance.labels[bit]), value));
      });
      vectors.push(vector);
    });
    return { inputs, vectors };
  };
  const checks = [];
  for (let previousClock = 0; previousClock < 2; previousClock++)
    for (let value = 0; value < 2 ** count; value++)
      for (let held = 0; held < 2 ** outCount; held++) {
        const baseline = events(table.idle[previousClock], 0, false),
          current = events(bits(value, count), 1),
          expect = {};
        let initialOutputs = 0;
        for (const [index, instance] of instances.entries()) {
          const retained = bits(held, outCount),
            result = nextOutputs(
              table,
              previousClock,
              current.vectors[index],
              retained,
            );
          retained.forEach(
            (bit, output) =>
              (initialOutputs += bit * 2 ** (index * outCount + output)),
          );
          result.forEach(
            (bit, output) =>
              (expect["signal." + pinId(instance.labels[count + output])] =
                bit),
          );
        }
        checks.push({
          name: `Clock ${previousClock}, inputs ${value}, retained ${held}`,
          parameters: { initialOutputs },
          ticks: 1,
          inputs: [...baseline.inputs, ...current.inputs],
          expect,
        });
      }
  const start = table.clock.edges[0] === "rise" ? 0 : 1,
    exampleInputs = events(table.idle[start], 0, false).inputs;
  let duration = 1;
  for (let value = 0; value < 2 ** count; value++) {
    const values = bits(value, count);
    if (values[table.clock.index] !== 1 - start) continue;
    const prepare = [...values];
    prepare[table.clock.index] = start;
    exampleInputs.push(
      ...events(prepare, duration).inputs,
      ...events(values, duration + 1).inputs,
    );
    duration += 4;
  }
  return { checks, exampleInputs, duration };
}
