import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { modelId } from "../model/builders/sourced.js";

export async function textRows(value, label = "Rules") {
  if (!value.trim().startsWith("@")) return value;
  const path = value.trim().slice(1),
    unquoted = /^(['"]).*\1$/.test(path) ? path.slice(1, -1) : path;
  const file = await open(
    resolve(unquoted),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536)
      throw new Error(
        label + " must be a regular text file of at most 64 KiB.",
      );
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > 65536) throw new Error(label + " file exceeds 64 KiB.");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

export function newModelId(state, name) {
  const base = modelId(name);
  let id = base,
    suffix = 2;
  while (state.models.some((model) => model.id === id)) {
    const tail = "-" + suffix++;
    id = base.slice(0, 64 - tail.length) + tail;
  }
  return id;
}

export function askQuestion(app, question, options, value, next) {
  let pending;
  app.prompt(
    question.label,
    value,
    (text) =>
      app.task(async () => {
        try {
          options[question.key] = question.parse
            ? await question.parse(text)
            : text;
        } catch (error) {
          app.state.prompt = pending;
          pending.error = error.message;
          throw error;
        }
        return next();
      }),
    {
      allowEmpty: question.allowEmpty,
      help:
        question.help ||
        "Entered rules are developer choices. Review the cited source and declare assumptions; generated checks do not prove hardware fidelity.",
    },
  );
  pending = app.state.prompt;
}
