import { BDD, bitblast, SymbolicLimit } from "./bdd.js";
import { evaluate, literal, mask, binary } from "./expression.js";

function values(entries, supplied, label) {
  if (
    !supplied ||
    typeof supplied !== "object" ||
    Array.isArray(supplied) ||
    Object.keys(supplied).length !== entries.length
  )
    throw new Error("Supply every declared " + label + " value explicitly");
  return Object.fromEntries(
    entries.map((entry) => [
      entry.id,
      literal(supplied[entry.id], entry.width),
    ]),
  );
}
export function initialSnapshot(model) {
  return {
    state: Object.fromEntries(
      model.state.map((s) => [s.id, "0b" + binary(s.initial, s.width)]),
    ),
    inputs: Object.fromEntries(
      model.inputs.map((s) => [s.id, "0b" + binary(s.initial, s.width)]),
    ),
    previousClock: 0,
  };
}
function network(model, inputValues, stored, calculate) {
  const nodes = {},
    all = { input: inputValues, state: stored, node: nodes };
  const read = (destination) => {
    const link = model.connections.get(destination),
      value = all[link.source.kind][link.source.id];
    return calculate.slice(value, link.slice[1], link.width);
  };
  for (const node of model.nodes)
    nodes[node.id] = calculate.expression(node.expression, (port) =>
      read(`node.${node.id}.${port}`),
    );
  return {
    nodes,
    read,
    outputs: Object.fromEntries(
      model.outputs.map((output) => [output.id, read(`output.${output.id}`)]),
    ),
  };
}
const concrete = {
  slice: (value, low, size) => (value >> BigInt(low)) & mask(size),
  expression: evaluate,
};

export function evaluateStep(model, snapshot) {
  if (
    !snapshot ||
    Object.keys(snapshot).some(
      (key) => !["state", "inputs", "previousClock"].includes(key),
    ) ||
    ![0, 1].includes(snapshot.previousClock)
  )
    throw new Error(
      "Step needs explicit state, sampled inputs and previousClock 0/1",
    );
  const stored = values(model.state, snapshot.state, "state"),
    inputs = values(model.inputs, snapshot.inputs, "input"),
    old = network(model, inputs, stored, concrete);
  const edge = snapshot.previousClock === 0 && inputs[model.clock] === 1n;
  const next = { ...stored },
    updates = [];
  for (const element of model.state) {
    const read = (port) => old.read(`state.${element.id}.${port}`),
      matched = edge
        ? element.rules.filter((rule) => evaluate(rule.when, read) === 1n)
        : [];
    const winner = matched[0],
      accepted = matched.filter((rule) => rule.priority === winner?.priority);
    if (edge && !winner)
      throw new Error("Unspecified next-state case for " + element.id);
    const result = (rule) =>
      rule.hold ? stored[element.id] : evaluate(rule.value, read);
    if (accepted.some((rule) => result(rule) !== result(winner)))
      throw new Error("Contradictory equal-priority updates for " + element.id);
    if (winner) next[element.id] = result(winner);
    const paths = new Map();
    const selectedRead = (destination) => {
      const link = model.connections.get(destination);
      paths.set(destination, {
        from: link.from,
        to: destination,
        slice: link.slice,
      });
      let value;
      if (link.source.kind === "node") {
        const node = model.nodes.find((node) => node.id === link.source.id);
        value = evaluate(node.expression, (port) =>
          selectedRead(`node.${node.id}.${port}`),
        );
      } else
        value = (link.source.kind === "state" ? stored : inputs)[
          link.source.id
        ];
      return (value >> BigInt(link.slice[1])) & mask(link.width);
    };
    if (winner) {
      evaluate(winner.when, (port) =>
        selectedRead(`state.${element.id}.${port}`),
      );
      if (!winner.hold)
        evaluate(winner.value, (port) =>
          selectedRead(`state.${element.id}.${port}`),
        );
    }
    updates.push({
      state: element.id,
      old: "0b" + binary(stored[element.id], element.width),
      next: "0b" + binary(next[element.id], element.width),
      rule: winner?.id ?? null,
      priority: winner?.priority ?? null,
      reason: winner?.reason ?? "no rising edge",
      matched: matched.map((rule) => rule.id),
      accepted: accepted.map((rule) => rule.id),
      selectedDependencies: [...paths.values()],
      ports: Object.fromEntries(
        Object.entries(element.ports).map(([port, bits]) => [
          port,
          "0b" + binary(read(port), bits),
        ]),
      ),
    });
  }
  // All next values read the same old network; commit only after every rule.
  const settled = network(model, inputs, next, concrete);
  const format = (entries, supplied) =>
    Object.fromEntries(
      entries.map((entry) => [
        entry.id,
        "0b" + binary(supplied[entry.id], entry.width),
      ]),
    );
  return {
    format: "chipsim-circuit-step",
    version: 1,
    event: edge ? "rising" : "none",
    previousClock: snapshot.previousClock,
    clock: Number(inputs[model.clock]),
    state: format(model.state, stored),
    next: format(model.state, next),
    inputs: format(model.inputs, inputs),
    outputsBefore: format(model.outputs, old.outputs),
    outputsAfter: format(model.outputs, settled.outputs),
    nodesBefore: format(model.nodes, old.nodes),
    updates,
    scope:
      "One binary event; simultaneous old-state sampling and post-commit combinational settling; no physical timing",
  };
}

export function checkCoverage(model, limits) {
  const entries = [
    ...model.inputs
      .filter((entry) => entry.id !== model.clock)
      .map((entry) => ({ ...entry, prefix: "input" })),
    ...model.state.map((entry) => ({ ...entry, prefix: "state" })),
  ];
  const names = [];
  for (let bit = 0; bit < 64; bit++)
    for (const entry of entries)
      if (bit < entry.width) names.push(`${entry.prefix}.${entry.id}[${bit}]`);
  const bdd = new BDD(names, limits),
    symbolic = { input: { [model.clock]: [1] }, state: {} };
  const checks = [];
  const witness = (root) => {
    const assignment = bdd.witness(root),
      result = { state: {}, inputs: { [model.clock]: 1 }, previousClock: 0 };
    for (const entry of entries) {
      let value = 0n;
      for (let bit = 0; bit < entry.width; bit++)
        if (assignment[`${entry.prefix}.${entry.id}[${bit}]`])
          value |= 1n << BigInt(bit);
      result[entry.prefix === "state" ? "state" : "inputs"][entry.id] =
        "0b" + binary(value, entry.width);
    }
    return result;
  };
  try {
    names.forEach((name, index) => {
      const [, kind, id, bit] = /^(input|state)\.(\w+)\[(\d+)\]$/.exec(name);
      (symbolic[kind][id] ??= [])[Number(bit)] = bdd.variable(index);
    });
    // Network bits are evaluated lazily: unrelated wide arithmetic does not
    // consume a coverage budget when only simple control guards matter.
    const nodeCache = new Map(),
      get = (connection) => {
        const link = model.connections.get(connection),
          source = link.source;
        let value;
        if (source.kind !== "node") value = symbolic[source.kind][source.id];
        else {
          if (!nodeCache.has(source.id)) {
            const node = model.nodes.find((node) => node.id === source.id);
            nodeCache.set(
              source.id,
              bitblast(
                node.expression,
                (port) => get(`node.${node.id}.${port}`),
                bdd,
              ),
            );
          }
          value = nodeCache.get(source.id);
        }
        return value.slice(link.slice[1], link.slice[0] + 1);
      };
    for (const element of model.state) {
      const ref = (port) => get(`state.${element.id}.${port}`),
        guards = element.rules.map((rule) => bitblast(rule.when, ref, bdd)[0]);
      const covered = guards.reduce(
          (result, guard) => bdd.or(result, guard),
          0,
        ),
        missing = bdd.not(covered);
      checks.push({
        state: element.id,
        kind: "completeness",
        verdict: missing ? "fail" : "pass",
        ...(missing ? { counterexample: witness(missing) } : {}),
      });
      let higher = 0;
      for (let i = 0; i < element.rules.length; i++) {
        const rule = element.rules[i];
        if (i && rule.priority !== element.rules[i - 1].priority)
          higher = guards
            .slice(0, i)
            .reduce((sum, guard) => bdd.or(sum, guard), 0);
        for (
          let j = i + 1;
          j < element.rules.length &&
          element.rules[j].priority === rule.priority;
          j++
        ) {
          const overlap = bdd.and(
            bdd.not(higher),
            bdd.and(guards[i], guards[j]),
          );
          if (!overlap) continue;
          const left = rule.hold
              ? symbolic.state[element.id]
              : bitblast(rule.value, ref, bdd),
            right = element.rules[j].hold
              ? symbolic.state[element.id]
              : bitblast(element.rules[j].value, ref, bdd);
          const different = left.reduce(
              (result, bit, index) =>
                bdd.or(result, bdd.xor(bit, right[index])),
              0,
            ),
            conflict = bdd.and(overlap, different);
          checks.push({
            state: element.id,
            kind: "equal-priority agreement",
            rules: [rule.id, element.rules[j].id],
            verdict: conflict ? "fail" : "pass",
            ...(conflict ? { counterexample: witness(conflict) } : {}),
          });
        }
      }
    }
    return report(
      checks.some((check) => check.verdict === "fail")
        ? "counterexample"
        : "complete-scoped-proof",
    );
  } catch (error) {
    if (!(error instanceof SymbolicLimit)) throw error;
    checks.push({
      kind: "symbolic budget",
      verdict: "inconclusive",
      message: error.message,
    });
    return report("inconclusive");
  }
  function report(status) {
    return {
      format: "chipsim-circuit-coverage",
      version: 1,
      status,
      ok: status === "complete-scoped-proof",
      method: "reduced ordered binary decision diagram",
      scope:
        "Rule completeness and winning equal-priority agreement for every binary old-state/input assignment at one rising edge; not reachability or temporal/property/HDL-equivalence proof",
      domainBits: model.domainBits,
      assignments: (1n << BigInt(model.domainBits)).toString(),
      nodes: bdd.nodes.length,
      operations: bdd.operations,
      limits: bdd.limit,
      checks,
    };
  }
}
