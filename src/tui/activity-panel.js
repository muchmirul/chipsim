import { pad, wrapText } from "./text.js";

export const activityEvents = (state) =>
  (state.activity?.events || []).filter(
    (event) =>
      !state.activityFilter ||
      `${event.command} ${event.status} ${event.message} ${JSON.stringify(event.details || {})}`
        .toLowerCase()
        .includes(state.activityFilter.toLowerCase()),
  );

export function activityRows(state, height) {
  const row = (text, style = "") => ({ text, style });
  if (!state.activity)
    return [
      row("Agent activity · open with --watch /path/to/prepared-project"),
      row(
        "Agent commands record local progress; no model provider is started.",
        "dim",
      ),
    ];
  const events = activityEvents(state);
  state.activityIndex = state.activityFollow
    ? Math.max(0, events.length - 1)
    : Math.max(0, Math.min(events.length - 1, state.activityIndex));
  const selected = events[state.activityIndex];
  const details = selected
    ? wrapText(
        `${selected.message}\n${JSON.stringify(selected.details || {})}`,
        state.columns,
      )
    : [];
  const detailHeight = Math.min(Math.floor(height / 3), details.length + 1);
  state.activityDetailScroll = Math.max(
    0,
    Math.min(
      Math.max(0, details.length - Math.max(1, detailHeight - 1)),
      state.activityDetailScroll,
    ),
  );
  const count = Math.max(1, height - 4 - detailHeight);
  const first = Math.max(0, state.activityIndex - count + 1);
  return [
    row(
      `Agent activity · ${state.activity.enabled ? "WATCH LIVE" : "RELOAD PAUSED"} · ${state.activityFollow ? "following" : "browsing"}`,
      "selected",
    ),
    row(state.activity.project, "dim"),
    row(state.activity.status, "dim"),
    ...(events.length
      ? events
          .slice(first, first + count)
          .map((event, index) =>
            row(
              `${first + index === state.activityIndex ? "›" : " "} ${event.time.slice(11, 19)}Z ${pad(event.command, 7)} ${pad(event.status, 9)} ${event.message}`,
              first + index === state.activityIndex
                ? "selected"
                : event.status === "failed"
                  ? "error"
                  : "",
            ),
          )
      : [row("Waiting for agent commands or model edits…")]),
    ...(selected
      ? [
          row("Selected event · h/l scroll full details", "dim"),
          ...details
            .slice(
              state.activityDetailScroll,
              state.activityDetailScroll + Math.max(0, detailHeight - 1),
            )
            .map((text) => row(text)),
        ]
      : []),
    row(
      "j/k events · G follow newest · / filter · W pause/resume run reload",
      "dim",
    ),
  ].slice(0, height);
}
