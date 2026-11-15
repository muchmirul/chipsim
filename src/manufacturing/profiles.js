import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { identity } from "../design/store.js";
export const profileDirectory = fileURLToPath(
  new URL("./profiles/", import.meta.url),
);
export async function manufacturingProfiles() {
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
      status:
        verified?.digest === digest && verified?.nativeAcceptance === true
          ? "supported"
          : "candidate",
    });
  }
  return profiles;
}
export async function manufacturingProfile(id) {
  const profile = (await manufacturingProfiles()).find((p) => p.id === id);
  if (!profile) throw new Error("Unsupported manufacturing profile: " + id);
  return profile;
}
