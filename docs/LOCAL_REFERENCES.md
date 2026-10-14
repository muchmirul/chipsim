# Private vendor references

The public repository and npm archive contain **no vendor PDFs or extracted
manual text**. The reference catalog retains titles, publishers, revisions,
source URLs, page counts and SHA-256 hashes. Original ChipSim code, the six
teaching models and HDL/design examples work without those documents.

Obtain any needed reference yourself from its publisher, under that publisher's
terms. Preserve its original bytes. Place it outside your public checkout using
the relative path in [manifest.json](references/manifest.json):

```text
private-reference-root/
  docs/references/esp32-c6/espressif-esp32-c6-trm.pdf
  docs/references/esp32-c6/esp-idf-programming-guide.pdf
  ...only the references needed for your work...
```

Set the private root in the terminal running ChipSim:

```sh
export CHIPSIM_REFERENCE_ROOT=/absolute/path/to/private-reference-root
chipsim agent context esp32-c6
chipsim agent prepare \
  "$CHIPSIM_REFERENCE_ROOT/docs/references/esp32-c6/espressif-esp32-c6-trm.pdf" \
  --out chip-work
```

`agent context` includes each reference's publisher URL, expected fingerprint,
resolved private path and whether a file is present. Presence is not source
verification: actual program loading, model checks and runs still read the
original bytes, check hashes, and verify evidence on the stated PDF pages.
The built-in Sources view, programming-guide verifier and design task resource
capture use this same private root. Explicitly selected/imported PDFs remain
explicit input paths; no command silently downloads or substitutes a manual.
An explicitly configured alternate TUI/test root takes precedence over the
environment root.

Reviewed profiles require their exact pinned revisions. A newer PDF with the
same product name is not a drop-in replacement. Unfamiliar sources still follow
the normal prepare/author/check workflow; a matching title does not establish
source identity or hardware fidelity.

## Testing without redistributing references

```sh
npm ci
npm test
npm run verify
npm run test:install
```

These commands run the public source-free checks, including original/synthetic
PDF fixtures where needed. Tests that require publisher originals are explicitly
marked skipped when the complete private snapshot is absent. Verification prints
that source-backed acceptance was not run. Missing references are never treated
as successful source verification.

For the full original-source regression suite, supply all 34 exact cataloged
originals in a private root and run:

```sh
CHIPSIM_REFERENCE_ROOT=/absolute/private/root npm run test:references
CHIPSIM_REFERENCE_ROOT=/absolute/private/root npm run test:references -- --verify
CHIPSIM_REFERENCE_ROOT=/absolute/private/root npm run test:install
```

The reference runner validates the entire snapshot before starting. It creates
temporary ignored links for legacy test fixture paths and removes only those
links on completion or ordinary cancellation. Existing files are verified and
never overwritten. Git ignores the document paths and npm excludes PDFs and
extracted sources even while the test links exist. Private originals are not
changed. No test command fetches publisher documents.

`test:hdl` and `test:hdl-debug` require their separately installed real tools.
An optional comparison with a vendor-derived model is reported separately from
the source-free HDL arithmetic/logic oracle. Shipping tools, PDKs, firmware or
saved runs has its own licensing obligations; see [Licensing](LICENSING.md).
