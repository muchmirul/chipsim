// A host-terminal lifecycle harness: no LLM, credentials, settings or agent turn.
import { registerChipSim } from "../../src/integrations/extension.js";
const commands = new Map();
const Type = new Proxy({}, { get: () => (value) => value });
registerChipSim(
  {
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  },
  Type,
);
const wasRaw = !!process.stdin.isRaw;
process.stdin.setRawMode(true);
process.stdin.resume();
const events = [];
try {
  const ctx = {
    cwd: process.cwd(),
    ...(process.argv[2] === "prime"
      ? { hasUI: true }
      : { mode: "tui", hasUI: true }),
    waitForIdle: async () => events.push("idle"),
    ui: {
      notify: (message, level) => {
        if (level === "error") throw new Error(message);
      },
      custom: async (factory) => {
        let result;
        factory(
          {
            stop() {
              events.push("stop");
              process.stdin.setRawMode(false);
              process.stdin.pause();
            },
            start() {
              events.push("start");
              process.stdin.setRawMode(true);
              process.stdin.resume();
            },
            requestRender() {
              events.push("render");
            },
          },
          null,
          null,
          (value) => {
            result = value;
          },
        );
        return result;
      },
    },
  };
  await commands.get("chipsim").handler("--model pio", ctx);
  if (events.join(",") !== "idle,stop,start,render" || !process.stdin.isRaw)
    throw new Error("Incorrect host handoff lifecycle: " + events.join(","));
  process.stdout.write("\nHOST_RESUMED raw=true\n");
} finally {
  process.stdin.setRawMode(wasRaw);
  process.stdin.pause();
  process.stdout.write("\x1b[?25h\nHANDOFF_COMPLETE\n");
}
