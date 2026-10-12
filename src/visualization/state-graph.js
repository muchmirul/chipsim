const symbols = {
  add: "+",
  sub: "−",
  mul: "×",
  div: "/",
  mod: "%",
  eq: "==",
  ne: "!=",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
  and: "AND",
  or: "OR",
  bitAnd: "&",
  bitOr: "|",
  bitXor: "^",
  shiftLeft: "<<",
  shiftRight: ">>",
};

export function expressionText(expression) {
  if (expression === null || typeof expression !== "object")
    return String(expression);
  if (expression.op === "not")
    return "NOT (" + expressionText(expression.args[0]) + ")";
  if (expression.op === "select")
    return (
      "(" +
      expressionText(expression.args[0]) +
      " ? " +
      expressionText(expression.args[1]) +
      " : " +
      expressionText(expression.args[2]) +
      ")"
    );
  return (
    "(" +
    expression.args
      .map(expressionText)
      .join(" " + (symbols[expression.op] || expression.op) + " ") +
    ")"
  );
}

function teachingGraph(id) {
  const nodes = ["send", "wait", "success", "timeout"].map((id) => ({
    id,
    label: id,
    terminal: ["success", "timeout"].includes(id),
  }));
  const edges = [
    { from: "send", to: "wait", guard: "Frame complete" },
    {
      from: "wait",
      to: "success",
      guard:
        id === "etpu"
          ? "Service accepts an ACK captured by the deadline"
          : "ACK high when polled",
    },
    {
      from: "wait",
      to: "timeout",
      guard:
        id === "etpu"
          ? "Service accepts a late capture or unacknowledged deadline"
          : "ACK low and deadline reached",
    },
  ];
  if (id === "pio") {
    nodes.unshift({ id: "load", label: "load", terminal: false });
    edges.unshift({ from: "load", to: "send", guard: "TX word supplied" });
  }
  if (["xmos", "etpu"].includes(id)) {
    nodes.push({ id: "fault", label: "fault", terminal: true });
    edges.push({
      from: "send",
      to: "fault",
      guard:
        id === "xmos"
          ? "Timed write submission missed"
          : "Match rearming missed",
    });
  }
  for (const node of nodes.filter((node) => !node.terminal))
    edges.push({
      from: node.id,
      to: node.id,
      guard: "Continue this phase",
      hold: true,
    });
  return {
    nodes,
    edges: edges.map((edge, index) => ({
      ...edge,
      id: "phase:" + index,
      priority: null,
      actions: [],
      evidence: [],
    })),
    scope: "Teaching scenario phases; semantic model ticks",
  };
}

// Declaration order is priority order. Implicit retention is distinct from an
// explicit self-transition, which executes actions/entry and resets stateAge.
export function stateGraph(model, trace, tick) {
  if (model.waveform)
    return {
      nodes: [],
      edges: [],
      current: null,
      scope: "Recorded HDL signals do not declare an FSM",
    };
  const specification = model.spec || model;
  let graph;
  if (model.kind === "builtin") graph = teachingGraph(model.id);
  else {
    graph = {
      scope: "Declared rules; first matching condition wins",
      nodes: specification.states.map((state) => ({
        id: state.id,
        label: state.label || state.id,
        terminal: !!state.terminal,
      })),
      edges: specification.states.flatMap((state) =>
        state.terminal
          ? []
          : [
              ...state.transitions.map((transition, index) => ({
                id: state.id + ":" + index,
                from: state.id,
                to: transition.to,
                index,
                priority: index + 1,
                guard: expressionText(transition.when),
                actions: transition.actions.map((action) =>
                  action.log !== undefined
                    ? "log: " + action.log
                    : action.target + " ← " + expressionText(action.value),
                ),
                evidence: transition.evidence || [],
                message: transition.message || "",
              })),
              {
                id: state.id + ":hold",
                from: state.id,
                to: state.id,
                guard: "Otherwise retain state (no transition)",
                hold: true,
                priority: null,
                actions: [],
                evidence: [],
              },
            ],
      ),
    };
  }
  const visits = new Map(graph.nodes.map((node) => [node.id, []])),
    traversals = new Map(graph.edges.map((edge) => [edge.id, []]));
  let selectedTransition = null;
  for (let index = 0; index < trace.length; index++) {
    const snapshot = trace[index],
      previous = trace[index - 1];
    visits.get(snapshot.state)?.push(snapshot.tick);
    if (!previous) continue;
    let edge;
    if (model.kind === "builtin")
      edge = graph.edges.find(
        (edge) => edge.from === previous.state && edge.to === snapshot.state,
      );
    else if (snapshot.transition)
      edge = graph.edges.find(
        (edge) =>
          edge.from === snapshot.transition.from &&
          edge.index === snapshot.transition.index &&
          edge.to === snapshot.transition.to &&
          !edge.hold,
      );
    else if (Object.hasOwn(snapshot, "transition"))
      edge = graph.edges.find(
        (edge) =>
          edge.hold &&
          edge.from === snapshot.state &&
          snapshot.phase !== "fault",
      );
    // Old externally supplied traces can identify a unique changing-state edge,
    // but cannot establish which of several equal-target rules was executed.
    else if (previous.state !== snapshot.state) {
      const candidates = graph.edges.filter(
        (edge) =>
          edge.from === previous.state &&
          edge.to === snapshot.state &&
          !edge.hold,
      );
      if (candidates.length === 1) edge = candidates[0];
    }
    if (edge) {
      traversals.get(edge.id).push(snapshot.tick);
      if (snapshot.tick === tick) selectedTransition = edge.id;
    }
  }
  return {
    ...graph,
    initial: specification.initialState || trace[0]?.state,
    current: trace[tick]?.state || null,
    selectedTransition,
    nodes: graph.nodes.map((node) => ({
      ...node,
      visits: visits.get(node.id),
    })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      ticks: traversals.get(edge.id),
    })),
  };
}
