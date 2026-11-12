import { createWorkbench } from "./service.js";
import { workbenchTools } from "./schema.js";
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
              "chipsim workbench TOOL --project DIRECTORY --input JSON\nchipsim mcp --project DIRECTORY (optional extensions/mcp npm ci)",
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
  ).call(name, JSON.parse(options["--input"] || "{}"));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}
