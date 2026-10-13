import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { files, fileDigest } from "./store.js";
import { payloadKind, capabilities } from "./adapters.js";

// Compatibility commands keep their output layout. They publish a bounded
// inventory but do not retrospectively claim a pre-execution design snapshot.
export async function inventoryStandalone(root, workflow, result) {
  try {
    const artifacts = [];
    for (const path of await files(root)) {
      if (path === "artifacts.json") continue;
      const kind = payloadKind(path, workflow);
      artifacts.push({
        path,
        kind,
        payload: await fileDigest(join(root, path)),
        capabilities: capabilities(kind),
      });
    }
    await writeFile(
      join(root, "artifacts.json"),
      JSON.stringify(
        {
          format: "chipsim-artifact-manifest",
          version: 1,
          workflow,
          provenance: "standalone",
          reusable: false,
          scope:
            "Native command outputs; use a design target for captured inputs, durable execution and graph registration.",
          execution: result.ok === false ? "failed" : "completed",
          artifacts,
          checks: result.checks || [],
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  } catch (error) {
    // Evidence publication failure must never trigger createDirectory cleanup.
    (result.warnings ||= []).push(
      "Artifact inventory failed: " + error.message,
    );
  }
  return result;
}
