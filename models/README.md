# Packaged models

Put validated schema-version-1 model JSON in this directory to include it in the app catalog. Run `npm run build` afterward. Browser-imported models do not require a rebuild and are saved separately in that browser.

See `../docs/MODEL_FORMAT.md` and `../examples/timer.model.json`. Files here must pass `npm run verify`; duplicate built-in IDs are forbidden. Avoid bundling unverified models or private source text. Vendor PDFs stay under `docs/references/` only when redistribution and provenance have been checked.
