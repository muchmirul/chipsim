import { pinId } from "./shared.js";
import { input } from "../builders/shared.js";

// Emit common controls once and rotate only independent data columns. Edge
// scenarios additionally fix clock columns; level scenarios have no clock.
export function inputVectors(table, instances, shared, fixed = []) {
  const columns = table.inputs
    .map((label, bit) => ({ label, bit }))
    .filter(
      ({ label, bit }) => !shared.includes(label) && !fixed.includes(bit),
    );
  return (values, tick, rotate = true) => {
    const inputs = [],
      vectors = [],
      emitted = new Set();
    instances.forEach((instance, index) => {
      const vector = [...values];
      let data = columns.reduce((value, { bit }) => value * 2 + values[bit], 0);
      data = (data + (rotate ? index : 0)) % 2 ** columns.length;
      columns.forEach(
        ({ bit }, offset) =>
          (vector[bit] = (data >> (columns.length - 1 - offset)) & 1),
      );
      vector.forEach((value, bit) => {
        const id = pinId(instance.labels[bit]);
        if (!emitted.has(id)) {
          inputs.push(input(tick, id, value));
          emitted.add(id);
        }
      });
      vectors.push(vector);
    });
    return { inputs, vectors };
  };
}
