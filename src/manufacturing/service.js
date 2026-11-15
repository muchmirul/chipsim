import { manufacturingProfiles, manufacturingProfile } from "./profiles.js";
import { serviceJob } from "./jobs.js";
import { bootstrapProject } from "./bootstrap.js";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

export async function manufacturingTool(root, operation, args) {
  if (operation === "manufacturing_profiles")
    return { profiles: await manufacturingProfiles() };
  if (operation === "environment_setup") {
    const profile = await manufacturingProfile(args.profile);
    const cache = resolve(
      process.env.CHIPSIM_MANUFACTURING_CACHE ||
        join(homedir(), ".cache/chipsim/manufacturing"),
      profile.digest,
    );
    return serviceJob(
      root,
      "setup",
      { profile: args.profile, cache },
      args.requestId,
    );
  }
  if (operation === "project_bootstrap") return bootstrapProject(root, args);
  if (operation === "release_status")
    return (await import("./release.js")).releaseStatus(root, args.run);
  if (operation === "release_package")
    return serviceJob(root, "package", { run: args.run }, args.requestId);
  throw new Error("Unknown manufacturing tool");
}
