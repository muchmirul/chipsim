#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { agentCommand } from "../src/agent/commands.js";

export async function main(args = process.argv.slice(2)) {
  const { result, exitCode } = await agentCommand(args);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = exitCode;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  await main();
