const quote = (value) => '"' + String(value ?? "").replaceAll('"', '""') + '"';

export function exportJSON(model, trace, parameters, inputs = []) {
  return JSON.stringify(
    {
      format: "chipsim-trace",
      version: 1,
      model: {
        id: model.id,
        name: model.name,
        fidelity: model.fidelity,
        scope: model.scope,
        sources: model.sources,
        evidence: model.evidence || [],
        assumptions: model.assumptions,
        definition: model.spec || null,
      },
      parameters,
      inputs,
      timing: { unit: "normalized tick", cycleAccurate: false },
      trace,
    },
    null,
    2,
  );
}

export function exportCSV(model, trace) {
  const signals = model.signals.map((signal) => signal.id),
    registers = [
      ...new Set(trace.flatMap((snapshot) => Object.keys(snapshot.registers))),
    ];
  const header = [
    "tick",
    "state",
    "phase",
    ...signals.map((id) => "signal." + id),
    ...registers.map((id) => "reg." + id),
    "event",
    "changes",
  ];
  const rows = trace.map((snapshot) => [
    snapshot.tick,
    snapshot.state,
    snapshot.phase,
    ...signals.map((id) => snapshot.signals[id]),
    ...registers.map((id) => snapshot.registers[id]),
    snapshot.message,
    snapshot.changes
      .map((change) => `${change.id}: ${change.before} -> ${change.after}`)
      .join("; "),
  ]);
  return (
    [header, ...rows].map((row) => row.map(quote).join(",")).join("\n") + "\n"
  );
}

export function exportVCD(model, trace) {
  const variables = [
    ...model.signals.map((signal) => ({ ...signal, kind: "signals" })),
    ...[
      ...new Set(trace.flatMap((snapshot) => Object.keys(snapshot.registers))),
    ].map((id) => ({
      id,
      width:
        model.registers?.find((register) => register.id === id)?.width || 32,
      kind: "registers",
    })),
  ];
  const code = (index) => "v" + index;
  const lines = [
    "$version ChipSim $end",
    "$comment One VCD time unit represents one normalized model tick, not a physical nanosecond. $end",
    "$timescale 1ns $end",
    "$scope module chipsim $end",
    ...variables.map(
      (variable, index) =>
        `$var wire ${variable.width} ${code(index)} ${variable.kind}_${variable.id} $end`,
    ),
    "$upscope $end",
    "$enddefinitions $end",
  ];
  let previous = null;
  for (const snapshot of trace) {
    const changes = variables.flatMap((variable, index) => {
      const value = snapshot[variable.kind][variable.id] ?? 0;
      if (previous && previous[variable.kind][variable.id] === value) return [];
      return [
        `b${(Math.trunc(value) >>> 0).toString(2).padStart(variable.width, "0")} ${code(index)}`,
      ];
    });
    if (changes.length) lines.push("#" + snapshot.tick, ...changes);
    previous = snapshot;
  }
  return lines.join("\n") + "\n";
}

export function download(text, filename, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type })),
    link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
