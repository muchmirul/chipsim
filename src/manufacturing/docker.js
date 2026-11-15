import { join, delimiter } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { executable } from "../design/project.js";

// Tag daemon-owned containers as well as tracking the client processes. Killing
// a docker client alone does not reliably stop work running inside its daemon.
export async function dockerEnvironment(context, path = process.env.PATH) {
  const docker = await executable("docker");
  if (!docker) throw new Error("A usable Docker engine is a host prerequisite");
  const directory = join(context.workspace, "out/chipsim-container-bin");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "docker"),
    `#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\nt=os.environ.get('CHIPSIM_JOB_TOKEN')\nif t and a and a[0]=='run': a[1:1]=['--label','chipsim.job='+t]\nos.execv(${JSON.stringify(docker)},[${JSON.stringify(docker)},*a])\n`,
    { mode: 0o755 },
  );
  if (context.owners) {
    await mkdir(context.owners, { recursive: true });
    await writeFile(
      join(context.owners, "containers.json"),
      JSON.stringify({ docker }),
    );
  }
  return { PATH: [directory, path].join(delimiter) };
}
