# Packaged models

Put validated schema-version-1 model JSON in this directory to include it in the TUI catalog on the next launch. No build is required. Models imported with `d` are saved in the selected terminal workspace.

See `../docs/MODEL_FORMAT.md` and `../examples/timer.model.json`. Files here must pass `npm run verify`; duplicate built-in IDs are forbidden. Avoid bundling unverified models or private source text. Vendor PDFs stay under `docs/references/` only when redistribution and provenance have been checked.
