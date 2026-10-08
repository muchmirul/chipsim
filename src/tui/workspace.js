import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  copyFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
export async function writeJSON(path, data) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n");
  await rename(temporary, path);
}
export class Workspace {
  constructor(path) {
    this.path = resolve(path);
  }
  async records(store) {
    const directory = join(this.path, store);
    await mkdir(directory, { recursive: true });
    const entries = [],
      errors = [];
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      try {
        const path = join(directory, file),
          text = await readFile(path, "utf8");
        entries.push(JSON.parse(text));
      } catch (error) {
        errors.push(file + ": " + error.message);
      }
    }
    return { entries, errors };
  }
  async saveModel(spec) {
    await writeJSON(join(this.path, "models", spec.id + ".json"), spec);
  }
  async backupSession(session) {
    const path = join(
      this.path,
      "revisions",
      session.modelId,
      Date.now() + "-" + randomUUID() + ".session.json",
    );
    await writeJSON(path, session);
    return path;
  }
  async revisions(id) {
    const directory = join(this.path, "revisions", id);
    let files;
    try {
      files = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return files
      .filter((file) =>
        /^\d{13}-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.session\.json$/.test(
          file,
        ),
      )
      .sort()
      .reverse()
      .map((file) => ({
        path: join(directory, file),
        name: file,
        timestamp: new Date(Number(file.split("-")[0])).toISOString(),
      }));
  }
  async saveDocument(document) {
    const directory = join(this.path, "documents");
    await mkdir(directory, { recursive: true });
    const target = join(directory, document.id + ".pdf");
    if (document.filePath !== target) await copyFile(document.filePath, target);
    const saved = { ...document, filePath: target };
    await writeJSON(join(directory, document.id + ".json"), saved);
    return saved;
  }
  exportPath(filename) {
    return join(this.path, "exports", filename);
  }
}
