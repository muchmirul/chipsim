import { createWorkbench } from "./service.js";
import { workbenchTools } from "./schema.js";
async function inputJSON(value = "{}") {
  if (value !== "-") return JSON.parse(value);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 8 * 1048576)
      throw new Error("Workbench stdin JSON exceeds 8 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}
export async function main(args) {
  if (!args.length || ["help", "--help", "tools"].includes(args[0])) {
    process.stdout.write(
      JSON.stringify(
        {
          format: "chipsim-workbench-result",
          version: 1,
          ok: true,
          result: {
            usage:
              "chipsim workbench TOOL --project DIRECTORY --input JSON|-\nUse --input - for bounded UTF-8 JSON from stdin (8 MiB transport; normal tool limits still apply).\nchipsim mcp --project DIRECTORY (optional extensions/mcp npm ci)",
            tools: workbenchTools,
          },
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const [name, ...rest] = args,
    options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (
      !["--project", "--input"].includes(rest[i]) ||
      rest[i + 1] === undefined ||
      options[rest[i]] !== undefined
    )
      throw new Error("Expected --project DIRECTORY and --input JSON");
    options[rest[i]] = rest[i + 1];
  }
  if (!options["--project"])
    throw new Error("Explicit --project DIRECTORY required");
  const result = await (
    await createWorkbench(options["--project"])
  ).call(name, await inputJSON(options["--input"]));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}
