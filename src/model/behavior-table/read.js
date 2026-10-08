const label = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
const forbidden = new Set(["constructor", "prototype"]);
export function tableLabels(value, kind, maximum) {
  const values =
    typeof value === "string" ? value.trim().split(/[\s,]+/) : value;
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > maximum ||
    values.some(
      (item) =>
        typeof item !== "string" ||
        !label.test(item) ||
        forbidden.has(item.toLowerCase()),
    ) ||
    new Set(values.map((item) => item.toLowerCase())).size !== values.length
  )
    throw new Error(
      `${kind}: use 1–${maximum} distinct names, starting with a letter (up to 24 letters/digits/underscores).`,
    );
  return [...values];
}
const bits = (value, length) =>
  Array.from({ length }, (_, at) => (value >> (length - 1 - at)) & 1);
const matches = (row, state, values) =>
  (row.from === "*" || row.from === state) &&
  row.inputs.every((cell, at) => cell === "X" || Number(cell) === values[at]);
const result = (row, retained) => ({
  state: row.to,
  outputs: row.outputs.map((cell, at) =>
    cell === "=" ? retained[at] : Number(cell),
  ),
});

// This is entered rule data, never interpretation of PDF prose/geometry.
export function readBehaviorTable(options) {
  const inputs = tableLabels(options.inputs, "Inputs", 6),
    outputs = tableLabels(options.outputs, "Outputs", 8),
    states = tableLabels(options.states, "States", 8);
  if (
    new Set([...inputs, ...outputs].map((item) => item.toLowerCase())).size !==
    inputs.length + outputs.length
  )
    throw new Error("Input and output names must be distinct.");
  if (
    typeof options.rules !== "string" ||
    !options.rules.trim() ||
    options.rules.length > 65536
  )
    throw new Error(
      "Enter behavior rows (at most 64 KiB), or load a rules file.",
    );
  const rows = options.rules
    .split(/[;\r\n]+/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (!rows.length || rows.length > 32)
    throw new Error("Use 1–32 behavior rows.");
  const rules = rows.map((text, index) => {
    const match =
      /^(\*|[A-Za-z][A-Za-z0-9_]*)\s+([01Xx]+)\s*->\s*([A-Za-z][A-Za-z0-9_]*)\s*\/\s*([01=]+)$/.exec(
        text,
      );
    if (!match)
      throw new Error(
        `Row ${index + 1}: use state INPUTBITS -> nextState / OUTPUTBITS (X = input wildcard, = = retain output).`,
      );
    const [, from, pattern, to, values] = match;
    if ((from !== "*" && !states.includes(from)) || !states.includes(to))
      throw new Error(
        `Row ${index + 1}: unknown state; names are case-sensitive.`,
      );
    if (pattern.length !== inputs.length || values.length !== outputs.length)
      throw new Error(
        `Row ${index + 1}: expected ${inputs.length} input bits and ${outputs.length} output bits.`,
      );
    return {
      from,
      inputs: [...pattern.toUpperCase()],
      to,
      outputs: [...values],
      text,
      number: index + 1,
    };
  });
  const held = outputs.flatMap((_, at) =>
    rules.some((row) => row.outputs[at] === "=") ? [at] : [],
  );
  const combinations = states.length * 2 ** (inputs.length + held.length);
  if (combinations > 64)
    throw new Error(
      `This table needs ${combinations} state/input/retained-output checks; the limit is 64. Reduce states, inputs, or retained output columns.`,
    );
  const cases = [];
  for (const state of states)
    for (let input = 0; input < 2 ** inputs.length; input++) {
      const values = bits(input, inputs.length),
        rows = rules.filter((row) => matches(row, state, values));
      if (!rows.length)
        throw new Error(
          `No row covers state ${state}, inputs ${values.join("")}. Add an explicit hold row if that behavior is intended.`,
        );
      for (let previous = 0; previous < 2 ** held.length; previous++) {
        const retained = outputs.map((_, at) =>
            held.includes(at) ? (previous >> held.indexOf(at)) & 1 : 0,
          ),
          results = rows.map((row) => result(row, retained)),
          expected = results[0];
        if (
          results.some(
            (value) =>
              value.state !== expected.state ||
              value.outputs.some((bit, at) => bit !== expected.outputs[at]),
          )
        )
          throw new Error(
            `Rows ${rows.map((row) => row.number).join(", ")} disagree for state ${state}, inputs ${values.join("")}, prior outputs ${retained.join("")}. Row order does not establish priority.`,
          );
        cases.push({
          state,
          inputs: values,
          retained,
          expected,
          row: rows[0].number,
        });
      }
    }
  return { inputs, outputs, states, rules, cases, held };
}
