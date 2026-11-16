import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { identity } from "../design/store.js";
export const profileDirectory = fileURLToPath(
  new URL("./profiles/", import.meta.url),
);
export function acceptanceStatus(record, digest, runtime) {
  const reasons = [];
  if (!record?.nativeAcceptance) reasons.push("No native acceptance recorded");
  if (record?.digest !== digest) reasons.push("Profile digest differs");
  for (const key of ["sha256", "platform", "arch"])
    if (record?.runtime?.[key] !== runtime[key])
      reasons.push("Runtime " + key + " differs");
  return {
    status: reasons.length ? "candidate" : "supported",
    acceptance: {
      validatedAt: record?.validatedAt || null,
      scope: record?.scope || null,
      runtime: record?.runtime || null,
      currentRuntime: runtime,
      mismatchReasons: reasons,
    },
  };
}
export async function manufacturingProfiles() {
  const { runtimeIdentity } = await import("../design/project.js");
  const runtime = await runtimeIdentity();
  let acceptance = { profiles: {} };
  try {
    acceptance = JSON.parse(
      await readFile(
        new URL("../../docs/manufacturing-acceptance.json", import.meta.url),
        "utf8",
      ),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const profiles = [];
  for (const name of (await readdir(profileDirectory))
    .filter((p) => p.endsWith(".json"))
    .sort()) {
    const profile = JSON.parse(
      await readFile(new URL("./profiles/" + name, import.meta.url), "utf8"),
    );
    const digest = identity(profile);
    // Validation metadata describes native acceptance of the execution contract;
    // it does not alter that contract's identity or waive project release gates.
    const verified = acceptance.profiles?.[profile.id];
    profiles.push({
      ...profile,
      digest,
      ...acceptanceStatus(verified, digest, runtime),
    });
  }
  return profiles;
}
export async function manufacturingProfile(id) {
  const profile = (await manufacturingProfiles()).find((p) => p.id === id);
  if (!profile) throw new Error("Unsupported manufacturing profile: " + id);
  return profile;
}
