import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeFile, readFile } from "node:fs/promises";
import { execute } from "../design/process.js";
import { dockerEnvironment } from "./docker.js";
import { dependencyIdentity } from "../design/project.js";
import { fileDigest, identity } from "../design/store.js";
import { manufacturingProfile, profileDirectory } from "./profiles.js";

export async function setupEnvironment(
  { profile: id, cache: capturedCache },
  context,
) {
  const profile = await manufacturingProfile(id);
  const cache =
    capturedCache ||
    resolve(
      process.env.CHIPSIM_MANUFACTURING_CACHE ||
        join(homedir(), ".cache/chipsim/manufacturing"),
      profile.digest,
    );
  const locks = Object.fromEntries(
    ["support", "precheck"].map((name) => [
      name,
      join(profileDirectory, "ihp-" + name + ".lock"),
    ]),
  );
  for (const [key, path] of Object.entries(locks))
    if ((await fileDigest(path)).sha256 !== profile.locks[key])
      throw new Error("Profile Python lock changed: " + key);
  const output = join(context.workspace, "environment.json"),
    request = join(context.workspace, "setup-request.json");
  await writeFile(request, JSON.stringify({ profile, cache, locks, output }));
  const result = await execute(
    "python3",
    [
      fileURLToPath(
        new URL("../../scripts/manufacturing-setup.py", import.meta.url),
      ),
      request,
    ],
    {
      ...context,
      cwd: context.workspace,
      timeoutMs: 7200000,
      env: {
        ...(await dockerEnvironment(context)),
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  if (!result.ok)
    throw new Error(
      "Environment setup failed: " +
        (result.reason || result.code) +
        "; inspect job logs",
    );
  const environment = JSON.parse(await readFile(output, "utf8"));
  environment.dependencies = [];
  for (const path of [
    environment.pdkRoot,
    environment.template,
    environment.support,
    join(cache, "support-venv"),
    join(cache, "precheck-venv"),
  ])
    environment.dependencies.push({
      path,
      sha256: await dependencyIdentity(path),
    });
  environment.identity = identity(environment);
  await writeFile(output, JSON.stringify(environment, null, 2));
  return environment;
}
