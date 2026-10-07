# ChipSim

ChipSim is an offline, interactive guide to programmable I/O. Follow the same DATA, CLK, and ACK transfer through six architectures, step through their internal state, and see how resource constraints affect the output.

The application is a single HTML file with embedded JavaScript, CSS, and SVG. No installation, build step, account, or internet connection is needed to run it.

## Run

Open [index.html](index.html) in a modern browser. Keep the `docs/` directory beside it to open the bundled PDF references offline.

For an optional local server, run this from the repository directory:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8000/`. A selected architecture can be linked with `#chip=pio`; a comparison uses `#chip=pio&compare=pru`.

## Use the simulator

1. Set the payload, frame length (8 or 12 bits), clock half-period, and ACK behavior.
2. Select an architecture, or enable **Compare two**.
3. Use **Step**, **Back**, **Run/Pause**, **Reset**, or the timeline to inspect execution.
4. Enable **Try the constraint** to observe that architecture's resource experiment.
5. Expand **Hardware scope, limitations and official sources** for local PDFs and publisher links.

The diagram highlights active blocks. The recipe highlights the current semantic action. The waveform shows DATA, CLK, and ACK alongside decoded payload and frame timing.

Space toggles playback; the left and right arrow keys step backward and forward when focus is outside interactive controls.

**Save offline HTML** exports `chipsim.html` with the current configuration and playback reset to tick zero. The exported simulator runs independently. Its local PDF links require the accompanying `docs/` directory; the PDF files are not embedded in the export.

## Architectures and references

| Architecture | Modeled mechanism | Bundled reference PDFs |
| --- | --- | --- |
| RP2040 PIO | Instruction-driven state machine, FIFO, shift register, and mapped pins | [RP2040 datasheet](docs/references/rp2040-datasheet.pdf#page=312) |
| TI PRU | AM335x PRU firmware using direct R30 output and R31 input | [AM335x technical reference manual](docs/references/ti-am335x-trm-spruh73q.pdf#page=208) |
| NXP FlexIO | S32K144-style timer and transmit shifter, with host ACK handling | [AN12174](docs/references/nxp-flexio-an12174.pdf#page=3) |
| PSoC UDB | Configured PLDs, datapaths, control stores, and routing | [PSoC 5LP architecture TRM](docs/references/infineon-psoc5lp-architecture-trm.pdf#page=165) |
| XMOS xCORE | Task scheduling and one pending timed port write | [XS3 architecture](docs/references/xmos-xs3-architecture.pdf), [AN03001 clocked I/O](docs/references/xmos-clocked-io-an03001.pdf) |
| NXP eTPU | Channel match/capture hardware and shared microengine service | [AN2933 channel hardware](docs/references/nxp-etpu-channel-hardware-an2933.pdf), [AN2353 essentials](docs/references/nxp-etpu-essentials-an2353.pdf) |

All eight documents cited by the original simulation are included as complete, unmodified vendor PDFs. The [reference guide](docs/REFERENCES.md) records versions, relevant sections, official download URLs, and how each source relates to the model. The [manifest](docs/references/manifest.json) pins each downloaded file with its size, page count, retrieval date, and SHA-256 checksum.

## Simulation scope

These are behavioral teaching models. A step is one **normalized protocol tick**, which may summarize several internal operations. The recipes are explanatory pseudocode. The simulator does not execute vendor firmware, reproduce all registers, or claim cycle-accurate timing, electrical behavior, power, or silicon performance.

The shared protocol sends the payload LSB first. DATA is prepared before rising CLK edges. The nominal frame length is `bits × 2 × H` ticks. ACK arrives three ticks after the actual completed frame, or remains missing. Its budget is eight ticks after actual completion; a timely ACK has priority at the deadline by model convention.

The resource experiments intentionally differ:

| Architecture | Experiment |
| --- | --- |
| PIO | Withhold the initial FIFO word until tick 4. |
| PRU | Pause firmware during ticks 4–7. |
| FlexIO | Keep the host busy during ticks 4–7 while loaded hardware continues. |
| UDB | Gate the protocol clock during ticks 4–7. |
| xCORE | Delay the task during ticks 4–9; only an already submitted write can complete. |
| eTPU | Delay service during ticks 4–9; armed matches can fire until rearming is needed. |

These experiments illustrate constraints and are not a common performance benchmark. Model-specific assumptions appear in the source panels and [reference guide](docs/REFERENCES.md).

## Repository layout

```text
index.html                    Application and all six models
README.md                     Usage and scope
THIRD_PARTY_NOTICES.md         Vendor-document attribution
docs/REFERENCES.md            Source-to-model reference guide
docs/DEVELOPMENT.md           Code structure and maintenance
docs/references/*.pdf         Eight complete official reference PDFs
docs/references/manifest.json Versions, origins, and checksums
scripts/verify.mjs            Offline integrity and model smoke checks
```

## Verify and develop

With Node.js 18 or newer installed, run:

```sh
node scripts/verify.mjs
```

This checks PDF integrity against the manifest, local reference coverage, JavaScript syntax, and baseline success/timeout transfers for all six models. It does not establish hardware accuracy or replace browser inspection. See [DEVELOPMENT.md](docs/DEVELOPMENT.md) before changing a model.

ChipSim is based on the supplied `architecture-comparison.html`, with ChipSim branding and the requested Section 8 heading and description removed. The comparison table and six interactive models are retained. Vendor-document attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
