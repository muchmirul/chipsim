import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);

test("ChipSim exposes a terminal interface without a web frontend or toolchain", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  for (const name of ["start", "dev", "tui"])
    assert.equal(pkg.scripts[name], "node scripts/chipsim.mjs");
  for (const name of Object.keys(pkg.scripts))
    assert.ok(!/^(?:build|web|dev:web|test:ui|verify:web)$/.test(name), name);
  for (const name of [
    "@playwright/test",
    "playwright",
    "esbuild",
    "pdfjs-dist",
  ])
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ])
      assert.ok(!pkg[field]?.[name], `${field} must not include ${name}`);
  assert.ok(!pkg.files.some((path) => /\.html$/.test(path)));
  for (const path of [
    "src/ui",
    "src/documents/pdf.js",
    "src/documents/store.js",
    "scripts/build.mjs",
    "scripts/serve.mjs",
    "index.html",
    "chipsim.html",
    ".generated",
    "playwright.config.js",
    "test/ui",
  ])
    await assert.rejects(access(new URL(path, root)), { code: "ENOENT" });

  for (const directory of ["src/", "scripts/"]) {
    const base = new URL(directory, root);
    for (const file of await readdir(base, { recursive: true })) {
      assert.ok(!/\.(?:html|css)$/.test(file), `${directory}${file}`);
      if (!/\.(?:js|mjs)$/.test(file)) continue;
      const source = await readFile(new URL(file, base), "utf8");
      assert.doesNotMatch(
        source,
        /\b(?:indexedDB|requestAnimationFrame)\b|\b(?:window|document)\.(?:querySelector|createElement|addEventListener)\b|from ["']node:https?["']/,
        `${directory}${file} must remain terminal/headless code`,
      );
    }
  }
  const obsoleteWebCheck = spawnSync(
    process.execPath,
    [new URL("scripts/verify.mjs", root).pathname, "--web"],
    { encoding: "utf8" },
  );
  assert.equal(obsoleteWebCheck.status, 2);
  assert.match(obsoleteWebCheck.stderr, /TUI-only verification/);
});
