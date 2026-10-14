import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  referencePath,
  referenceAvailable,
} from "../src/documents/references.js";
import { verifyProgramGuides } from "../src/program/guides.js";
import { parseProgram } from "../src/program/parse.js";
import { builtinModels } from "../src/models/index.js";
import manifest from "../docs/references/manifest.json" with { type: "json" };

test("private guide discovery never turns a present wrong PDF into source verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chipsim-private-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.CHIPSIM_REFERENCE_ROOT;
  process.env.CHIPSIM_REFERENCE_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CHIPSIM_REFERENCE_ROOT;
    else process.env.CHIPSIM_REFERENCE_ROOT = previous;
  });
  const source = manifest.documents.find(
    (doc) => doc.id === "rp2040-pico-c-sdk",
  );
  const path = referencePath(source);
  assert.equal(path, join(root, source.path));
  assert.equal(referenceAvailable(source), false);
  const program = parseProgram(
    'model pio\nguide rp2040-pico-c-sdk 250 "pio_sm_put_blocking"\nhalt',
  );
  const pio = builtinModels.find((model) => model.id === "pio");
  await assert.rejects(
    verifyProgramGuides(program, pio),
    /ENOENT|no such file/,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    "%PDF-1.4\nUnrelated original test bytes, not a vendor document.\n%%EOF\n",
  );
  assert.equal(referenceAvailable(source), true);
  await assert.rejects(
    verifyProgramGuides(program, pio),
    /fingerprint changed/,
  );
  const alternate = join(root, "explicit-root");
  assert.equal(
    referencePath(source, { root: alternate }),
    join(alternate, source.path),
  );
  await assert.rejects(
    verifyProgramGuides(program, pio, { root: alternate }),
    /ENOENT|no such file/,
  );
});

test("catalog path validation cannot escape a configured private root", () => {
  for (const path of [
    "../manual.pdf",
    "docs/references/../../manual.pdf",
    "/manual.pdf",
    "docs/references/x/file.js",
  ])
    assert.throws(() => referencePath(path), /Invalid catalog reference/);
});
