#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const html = read('index.html').toString('utf8');
const manifest = JSON.parse(read('docs/references/manifest.json'));

function script(id) {
  const match = html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`));
  assert.ok(match, `Missing script: ${id}`);
  return match[1];
}

const core = new Script(script('lab-core'), { filename: 'lab-core.js' });
new Script(script('lab-ui'), { filename: 'lab-ui.js' });
const context = createContext({});
core.runInContext(context, { timeout: 5000 });
const lab = context.architectureLab;
assert.equal(lab.ids.length, 6);

const references = new Set();
const covered = new Set();
let pdfBytes = 0;
for (const doc of manifest.documents) {
  assert.ok(!references.has(doc.path), `Duplicate document: ${doc.path}`);
  const data = read(doc.path);
  assert.equal(data.subarray(0, 5).toString(), '%PDF-', `Not a PDF: ${doc.path}`);
  assert.ok(data.subarray(-2048).includes(Buffer.from('%%EOF')), `Incomplete PDF: ${doc.path}`);
  assert.equal(data.length, doc.bytes, `File size mismatch: ${doc.path}`);
  assert.equal(createHash('sha256').update(data).digest('hex'), doc.sha256,
    `Checksum mismatch: ${doc.path}`);
  assert.ok(doc.pdf_start_page >= 1 && doc.pdf_start_page <= doc.pages,
    `Invalid reference page: ${doc.path}`);
  assert.ok(doc.source_url.startsWith('https://'), `Missing official origin: ${doc.path}`);
  for (const id of doc.chips) {
    assert.ok(lab.ids.includes(id), `Unknown model: ${id}`);
    covered.add(id);
  }
  references.add(doc.path);
  pdfBytes += data.length;
}
assert.equal(references.size, 8, 'Expected all eight cited PDFs');
for (const id of lab.ids) assert.ok(covered.has(id), `No reference for ${id}`);

const local = JSON.parse(script('lab-ui').match(/const BUNDLED_REFERENCES=(.*);/)[1]);
for (const id of lab.ids) {
  assert.ok(local[id]?.length, `No offline source links for ${id}`);
  for (const [, href] of local[id]) {
    const path = href.split('#')[0];
    assert.ok(references.has(path), `Untracked PDF link: ${href}`);
    assert.ok(existsSync(new URL(path, root)), `Broken PDF link: ${href}`);
    assert.ok(manifest.documents.some(doc => doc.path === path && doc.chips.includes(id)),
      `Reference assigned to wrong model: ${href}`);
  }
}

let transfers = 0;
for (const id of lab.ids) {
  for (const bits of [8, 12]) {
    for (const ack of ['present', 'missing']) {
      const payload = bits === 8 ? 0xB3 : 0xAB3;
      const trace = lab.simulate(id, { payload, bits, half: 2, ack });
      const result = trace.find(state => ['success', 'timeout', 'fault'].includes(state.phase));
      assert.ok(result, `${id}: transfer never completes`);
      assert.equal(result.phase, ack === 'present' ? 'success' : 'timeout', `${id}: ACK outcome`);
      assert.equal(result.samples, bits, `${id}: receiver sample count`);
      assert.equal(result.decoded, payload, `${id}: decoded payload`);
      assert.equal(result.actualEnd, bits * 4, `${id}: nominal frame end`);
      transfers++;
    }
  }
}

console.log(`Verified ${references.size} PDFs (${(pdfBytes / 1048576).toFixed(1)} MiB), offline links for all six models, JavaScript syntax, and ${transfers} baseline transfers.`);
