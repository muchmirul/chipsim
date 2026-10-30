import { fields, width, literal, expression } from "./expression.js";

export const circuitLimits = Object.freeze({
  fileBytes: 1048576,
  vectorWidth: 64,
  stateBits: 512,
  domainBits: 512,
  states: 64,
  nodes: 128,
  connections: 1024,
  rules: 512,
  tableRows: 256,
  expressionNodes: 4096,
});
const identifier = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
function id(value) {
  if (typeof value !== "string" || !identifier.test(value))
    throw new Error(
      "Circuit identifiers must be 1..32 ASCII letters/digits/underscores, starting with a letter",
    );
  return value;
}
function list(value, label, max, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > max)
    throw new Error(`${label} needs ${minimum}..${max} entries`);
  const names = new Set();
  for (const entry of value) {
    id(entry?.id);
    if (names.has(entry.id))
      throw new Error("Duplicate " + label + " identifier " + entry.id);
    names.add(entry.id);
  }
  return value;
}
function ports(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 32
  )
    throw new Error("Expected at most 32 named input ports");
  return Object.fromEntries(
    Object.entries(value).map(([name, bits]) => [id(name), width(bits)]),
  );
}
function tableRules(table, portWidths) {
  fields(table, ["columns", "rows"]);
  if (
    !Array.isArray(table.columns) ||
    !table.columns.length ||
    new Set(table.columns).size !== table.columns.length ||
    table.columns.some((name) => !Object.hasOwn(portWidths, name))
  )
    throw new Error("Table columns must name distinct connected ports");
  list(table.rows, "table rows", circuitLimits.tableRows, 1);
  const bits = table.columns.reduce((sum, name) => sum + portWidths[name], 0);
  return table.rows.map((row) => {
    fields(row, ["id", "match", "priority", "reason"], ["value", "hold"]);
    if (
      typeof row.match !== "string" ||
      row.match.length !== bits ||
      !/^[01X]+$/.test(row.match)
    )
      throw new Error(
        "Table match must give every column bit in MSB-first order using 0/1/X",
      );
    let offset = 0,
      when = { bits: 1, width: 1 };
    for (const name of table.columns) {
      const size = portWidths[name],
        match = row.match.slice(offset, offset + size);
      offset += size;
      const care = "0b" + match.replace(/[01]/g, "1").replaceAll("X", "0"),
        value = "0b" + match.replaceAll("X", "0");
      when = {
        op: "and",
        args: [
          when,
          {
            op: "eq",
            args: [
              { op: "and", args: [{ ref: name }, { bits: care, width: size }] },
              { bits: value, width: size },
            ],
          },
        ],
      };
    }
    const { match, ...rest } = row;
    return { ...rest, when };
  });
}

export function compileCircuit(input) {
  input = structuredClone(input);
  // Reject data loss (undefined/BigInt/non-JSON values) through schema checks;
  // imported input stays independent of the compiled maps and expressions.
  fields(
    input,
    [
      "format",
      "version",
      "id",
      "name",
      "clock",
      "inputs",
      "state",
      "nodes",
      "outputs",
      "connections",
    ],
    ["description"],
  );
  if (input.format !== "chipsim-circuit" || input.version !== 1)
    throw new Error("Expected chipsim-circuit version 1");
  id(input.id);
  for (const [label, max] of [
    ["name", 100],
    ["description", 2000],
  ]) {
    if (
      input[label] !== undefined &&
      (typeof input[label] !== "string" ||
        !input[label].trim() ||
        input[label].length > max ||
        /[\x00-\x1f\x7f]/.test(input[label]))
    )
      throw new Error("Invalid circuit " + label);
  }
  fields(input.clock, ["signal", "edge"]);
  if (input.clock.edge !== "rising")
    throw new Error(
      "Only one explicitly declared rising-edge clock is supported; asynchronous controls/latches/multiple clocks are unsupported",
    );
  const budget = { count: 0 };
  const inputs = list(input.inputs, "inputs", 64, 1).map((entry) => {
    fields(entry, ["id", "width", "initial"]);
    return {
      ...entry,
      width: width(entry.width),
      initial: literal(entry.initial, entry.width),
    };
  });
  const clock = inputs.find((entry) => entry.id === input.clock.signal);
  if (!clock || clock.width !== 1 || clock.initial !== 0n)
    throw new Error(
      "The rising-edge clock must be a declared 1-bit input with explicit initial 0 (no invented initialization edge)",
    );
  let ruleCount = 0;
  const state = list(input.state, "state", circuitLimits.states, 1)
    .map((entry) => {
      fields(entry, ["id", "width", "initial", "ports"], ["rules", "table"]);
      if (Object.hasOwn(entry, "rules") === Object.hasOwn(entry, "table"))
        throw new Error(
          "Each state element needs exactly one rules list or explicit table",
        );
      const portWidths = ports(entry.ports);
      const rows = entry.table
        ? tableRules(entry.table, portWidths)
        : entry.rules;
      list(rows, "rules", circuitLimits.rules, 1);
      ruleCount += rows.length;
      const rules = rows
        .map((rule) => {
          fields(rule, ["id", "priority", "reason", "when"], ["hold", "value"]);
          if (
            !Number.isSafeInteger(rule.priority) ||
            rule.priority < 0 ||
            rule.priority > 65535
          )
            throw new Error(
              "Rule priority must be explicit integer 0..65535; higher wins",
            );
          if (!["load", "hold", "reset", "safety"].includes(rule.reason))
            throw new Error("Rule reason must be load, hold, reset or safety");
          if (
            (rule.hold !== true && !Object.hasOwn(rule, "value")) ||
            (Object.hasOwn(rule, "hold") && rule.hold !== true) ||
            (rule.hold && Object.hasOwn(rule, "value")) ||
            (rule.reason === "hold") !== (rule.hold === true)
          )
            throw new Error(
              "Each rule explicitly loads a value or holds; hold reasons require hold:true",
            );
          const when = expression(rule.when, portWidths, budget);
          const value = rule.hold
            ? null
            : expression(rule.value, portWidths, budget);
          if (when.width !== 1 || (value && value.width !== entry.width))
            throw new Error(
              "Rule guard must be 1 bit; next value must match stored width",
            );
          return { ...rule, when, value };
        })
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
      return {
        ...entry,
        width: width(entry.width),
        initial: literal(entry.initial, entry.width),
        ports: portWidths,
        rules,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (ruleCount > circuitLimits.rules)
    throw new Error("Circuit exceeds 512 total rules");
  const nodes = list(input.nodes, "nodes", circuitLimits.nodes).map((entry) => {
    fields(entry, ["id", "width", "ports", "expression"]);
    const portWidths = ports(entry.ports),
      expr = expression(entry.expression, portWidths, budget);
    if (expr.width !== entry.width)
      throw new Error("Combinational node expression width mismatch");
    return {
      ...entry,
      width: width(entry.width),
      ports: portWidths,
      expression: expr,
    };
  });
  const outputs = list(input.outputs, "outputs", 64).map((entry) => {
    fields(entry, ["id", "width"]);
    return { ...entry, width: width(entry.width) };
  });
  const stateBits = state.reduce((sum, item) => sum + item.width, 0),
    domainBits =
      stateBits +
      inputs.reduce(
        (sum, item) => sum + (item.id === clock.id ? 0 : item.width),
        0,
      );
  if (
    stateBits > circuitLimits.stateBits ||
    domainBits > circuitLimits.domainBits
  )
    throw new Error("Circuit binary state/input domain exceeds 512 bits");
  const sources = new Map(),
    destinations = new Map();
  for (const [kind, entries] of [
    ["input", inputs],
    ["state", state],
    ["node", nodes],
  ]) {
    for (const entry of entries)
      sources.set(`${kind}.${entry.id}`, {
        kind,
        id: entry.id,
        width: entry.width,
      });
    if (kind !== "input")
      for (const entry of entries)
        for (const [port, bits] of Object.entries(entry.ports))
          destinations.set(`${kind}.${entry.id}.${port}`, bits);
  }
  for (const output of outputs)
    destinations.set(`output.${output.id}`, output.width);
  if (
    !Array.isArray(input.connections) ||
    input.connections.length > circuitLimits.connections
  )
    throw new Error("Expected at most 1024 explicit connections");
  const connections = new Map();
  for (const connection of input.connections) {
    fields(connection, ["from", "to"], ["slice"]);
    const source = sources.get(connection.from),
      destination = destinations.get(connection.to);
    if (!source || !destination)
      throw new Error(
        `Undeclared/unavailable connection: ${connection.from} -> ${connection.to}`,
      );
    if (source.kind === "input" && source.id === clock.id)
      throw new Error(
        "Clock is an event source, not a routable data/control path in circuit v1",
      );
    if (connections.has(connection.to))
      throw new Error("Multiple drivers for connected port " + connection.to);
    const slice = connection.slice ?? [source.width - 1, 0];
    if (
      !Array.isArray(slice) ||
      slice.length !== 2 ||
      slice.some((bit) => !Number.isInteger(bit)) ||
      slice[1] < 0 ||
      slice[0] < slice[1] ||
      slice[0] >= source.width ||
      slice[0] - slice[1] + 1 !== destination
    )
      throw new Error("Connection slice/port width mismatch: " + connection.to);
    connections.set(connection.to, {
      ...connection,
      source,
      slice,
      width: destination,
    });
  }
  for (const name of destinations.keys())
    if (!connections.has(name))
      throw new Error("Missing declared connection to " + name);
  const ordered = [],
    visiting = new Set(),
    visited = new Set(),
    byId = new Map(nodes.map((node) => [node.id, node]));
  function visit(node) {
    if (visiting.has(node.id))
      throw new Error("Unsupported combinational loop at node " + node.id);
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    for (const port of Object.keys(node.ports)) {
      const source = connections.get(`node.${node.id}.${port}`).source;
      if (source.kind === "node") visit(byId.get(source.id));
    }
    visiting.delete(node.id);
    visited.add(node.id);
    ordered.push(node);
  }
  nodes.forEach(visit);
  return {
    spec: input,
    inputs,
    state,
    nodes: ordered,
    outputs,
    connections,
    clock: clock.id,
    stateBits,
    domainBits,
  };
}
