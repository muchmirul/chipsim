import { display } from "./text.js";

export function programRows(state, height) {
  const debug = state.programDebugger;
  if (!debug)
    return [
      {
        text: "SOURCE PROGRAM · P loads a .chip experiment file",
        style: "selected",
      },
      {
        text: "Line stepping, breakpoints and signals share one experiment.",
        style: "dim",
      },
      {
        text: "See docs/PROGRAMMING.md · native binaries/assembly require a backend.",
        style: "dim",
      },
    ];
  const size = Math.max(2, height - 4),
    first = Math.min(
      Math.max(0, state.programLine - 1 - Math.floor(size / 2)),
      Math.max(0, debug.program.lines.length - size),
    );
  const rows = [
    {
      text: `EXPERIMENT SOURCE · ${debug.status} · next line ${debug.next?.line ?? "end"} · ${debug.steps.length} steps`,
      style: "selected",
    },
    ...debug.program.lines.slice(first, first + size).map((text, index) => {
      const line = first + index + 1;
      return {
        text: `${debug.next?.line === line ? "→" : " "}${debug.breakpoints.has(line) ? "●" : " "} ${String(line).padStart(4)}  ${text}`,
        style: line === state.programLine ? "selected" : "",
      };
    }),
    {
      text:
        "LOCALS · " +
        (Object.entries(debug.variables)
          .map(([key, value]) => key + "=" + display(value, state.format, 32))
          .join("  ") || "none"),
      style: "dim",
    },
    {
      text:
        debug.error?.message ||
        `N step · C continue · K breakpoint · J back · r reset · G guides · Q detach`,
      style: debug.error ? "error" : "dim",
    },
    {
      text: `GUIDES · ${debug.guides.length} verified · ${debug.guides[0]?.document || "none"} page ${debug.guides[0]?.page || "—"}`,
      style: "dim",
    },
  ];
  return rows.slice(0, height);
}
