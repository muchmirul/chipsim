# Original terminal captures

The four PNGs show ChipSim's original PIO teaching UI: waveforms, parameters,
hardware blocks and events. They contain no vendor document prose or table
captures. `frames.json` records the actual renderer rows and reproduction recipes.

With Node.js, Python, Pillow and DejaVu Sans Mono installed, run:

```sh
node scripts/capture-readme.mjs
python3 scripts/render-readme-screenshots.py
```

The capture uses isolated temporary workspaces and requires no vendor PDFs.
The Python renderer assigns fonts/colors to captured rows; it does not invent
values. Pillow and fonts are external documentation tools, not bundled binaries.
See [licensing notes](../LICENSING.md) before adding third-party visual material.
