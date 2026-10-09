# README terminal captures

These PNGs show ChipSim's actual terminal renderer, using validated models,
real vendor PDFs, program execution and command activity. They are not mockups.
The capture creates isolated temporary workspaces and an agent project, removes
them afterwards, and leaves user workspaces untouched.

From the repository, with Node.js 22.13+, Poppler, Python 3, Pillow and the
DejaVu Sans Mono font installed:

```sh
node scripts/capture-readme.mjs
python3 scripts/render-readme-screenshots.py
```

`frames.json` retains the exact text/style rows returned by `src/tui/render.js`,
the model/cursor, dimensions and a reproduction recipe for every image. The
Python script draws those rows at 110 columns × 36 rows, assigning terminal
colors and a monospace font. It does not rewrite labels or insert simulated
values. The original frame JSON makes the images searchable and auditable.

The generic counter/FIFO/shifter, entered NAND and scratch-register examples
contain explicitly selected scenario assumptions. The behavior comparison
deliberately forces the draft output high to demonstrate review; it is not a
vendor NAND implementation. The activity image records real prepare/context/
search/program-check/program-run operations; temporary paths and timestamps
vary when the captures are regenerated.

The screenshot tooling is a documentation utility. Pillow and fonts are not
runtime dependencies of ChipSim.
