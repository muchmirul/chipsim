import { localPath } from "./store.js";

export function validateEngineering(value) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("engineering must be an object");
  for (const key of Object.keys(value))
    if (
      !["requirements", "roles", "candidate", "capabilityContracts"].includes(
        key,
      )
    )
      throw new Error("Unknown engineering field " + key);
  if (
    value.candidate !== undefined &&
    (typeof value.candidate !== "string" || value.candidate.length > 128)
  )
    throw new Error("engineering.candidate must be a bounded label");
  if (value.requirements !== undefined) {
    if (!Array.isArray(value.requirements) || value.requirements.length > 256)
      throw new Error("Expected at most 256 requirement links");
    const ids = new Set();
    for (const requirement of value.requirements) {
      if (
        !requirement ||
        typeof requirement.id !== "string" ||
        !requirement.id ||
        requirement.id.length > 128 ||
        ids.has(requirement.id)
      )
        throw new Error("Expected unique requirement IDs");
      ids.add(requirement.id);
      if (
        requirement.url !== undefined &&
        (typeof requirement.url !== "string" ||
          requirement.url.length > 4096 ||
          !/^https:\/\//.test(requirement.url))
      )
        throw new Error("Requirement links require HTTPS URLs");
    }
  }
  if (value.roles !== undefined) {
    if (
      !value.roles ||
      typeof value.roles !== "object" ||
      Array.isArray(value.roles)
    )
      throw new Error("Expected engineering roles object");
    for (const [role, paths] of Object.entries(value.roles)) {
      if (
        !["hardware", "program", "tests", "constraints"].includes(role) ||
        !Array.isArray(paths) ||
        paths.length > 512
      )
        throw new Error(
          "Expected bounded hardware/program/tests/constraints path arrays",
        );
      paths.forEach(localPath);
    }
  }
  if (value.capabilityContracts !== undefined) {
    if (
      !Array.isArray(value.capabilityContracts) ||
      value.capabilityContracts.length > 128
    )
      throw new Error("Expected bounded capability contract paths");
    value.capabilityContracts.forEach(localPath);
  }
}
