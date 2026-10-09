# Entered register banks

Import a searchable manual with `d`, press `c`, and choose **Register bank**. This builds a source-linked register experiment from explicit addresses, reset words, masks, and access rules. The model uses the same `u` register menu, waveforms, logs, stimulus timeline, sessions, and JSON/CSV/VCD exports as reviewed chip profiles.

The builder does not infer a register map or semantics from PDF prose. A matching source quote establishes provenance; generated checks establish consistency with the entered rules. Review every address, width, reset domain, access mode, mask, and ordering rule against the manual before treating the experiment as a device model. Its scope, rules, synthetic events, and omissions remain visible in Model view (`5`) and exported JSON (`M`).

## Extracted register-table drafts

Import also reads supported positioned **Command Byte** and **Register Map** tables into a review inventory. This path currently requires explicit hex address, REGISTER, PROTOCOL, and POWER-UP DEFAULT headings; literal byte addresses; Read byte or Read/write byte access; and complete eight-bit 0/1/X default patterns. Optional CONTROL REGISTER BITS columns must name every descending bit through B0, agree with the literal addresses, and cover every combination. Missing cells, duplicates, unsupported qualifiers/continuations, inconsistent control bits, and ambiguous geometry reject the table rather than filling it.

After `c` → Register bank, choose **Enter rows manually** or a detected source table. Selecting a table prefills its byte width, addresses, access labels, known numeric defaults, source page, and caption quote. A reset containing X remains `?`; every operation mask remains `?`, since the table does not specify writable/clearable masks or side effects. Enter does not bypass these fields: the parser requires explicit reviewed values before creation. The selected table's eight-bit width and source page stay fixed; use manual entry for another width/source. Generated names replace spaces/punctuation with underscores only as editable aliases; conflicting aliases require manual naming.

Use **Export row draft** in the same menu to write a local `.registers.txt` template for editing. Existing files are preserved; choose a new output path. Fill each `?`, review masks/modes against the relevant behavioral sections, and load the file with `@path`. Creating a storage bank from these facts does not reproduce GPIO direction, input inversion, interrupt acknowledgment, command-pointer history, or other peripheral logic. Those need reviewed executable rules, such as the existing GPIO profiles. Edited rows remain developer-entered assumptions, rather than automatic table-derived behavior.

The original TCA9534 and PCA9555 PDFs supply four-row and eight-row regression examples on PDF page 19. Their Input Port defaults remain unknown in the inventory. `npm run document -- manual.pdf --json` includes `registerTables` separately from compiled `models`; `--out` still requires one actual executable model. The optional browser's document dialog displays the same inventory and exports the same unresolved row templates. Both text engines retain geometry for up to 32 register-table pages, independently of the existing function-table scan; scan limits and unsupported tables produce diagnostics. Inventories and row templates are local review data, not simulations.

## Rows and modes

Choose one word width from 1 to 32 bits for the bank, then enter rows separated by semicolons or load a regular text file with `@path/to/registers.txt`:

```text
NAME ADDRESS MODE RESET MASK
```

For example, `examples/status.registers.txt` contains an illustrative 32-bit control/status bank:

```text
CONTROL 0x00 rw 0x00000000 0x0000000F
STATUS  0x04 w1c 0x00000000 0x00000003
FLAGS   0x08 w1s 0x00000000 0x00000003
CAPTURE 0x0C rc 0x00000000 0xFFFFFFFF
ID      0x10 ro 0x12345678 0x00000000
```

These rows are an example, not a vendor device definition. Addresses, resets, and masks accept decimal, `0x`, `0b`, and `0o` forms. Names are unique, case-insensitive identifiers of 1–32 characters. Addresses must be distinct unsigned 32-bit values. Reset/mask values must fit the chosen word width. All five columns are required; omitted fields never receive guessed defaults.

| Mode  | Write behavior                                               | Read behavior                                 | Mask meaning                |
| ----- | ------------------------------------------------------------ | --------------------------------------------- | --------------------------- |
| `rw`  | Replace selected bits with written data; preserve other bits | Return current word                           | Bits writes may replace     |
| `ro`  | Ignore writes                                                | Return current word                           | Must be zero                |
| `w1c` | Clear selected bits whose written data is one                | Return current word                           | Bits written ones may clear |
| `w1s` | Set selected bits whose written data is one                  | Return current word                           | Bits written ones may set   |
| `rc`  | Ignore writes                                                | Return the word before clearing selected bits | Bits reads clear            |

Uniform modes apply to each word's mask. Mixed read-side effects, different per-field write modes, write-only words, read-triggered captures, aliases, and automatic peripheral datapaths need a separately reviewed JSON model. A protected bit simply retains storage across bus writes; it is not an inferred electrical/reserved-bit specification.

## Transactions, events, and ordering

Use `u` to choose a named address and Read or Write. Each changed request token after tick zero denotes one completed addressed word. Tick zero initializes the entered reset values and request baseline; held tokens never replay changed address/data fields. Accesses at unmapped addresses set the tool's `error`; retained read data and storage are preserved except for independent synthetic events. These are scenario statuses, not physical ACK/NACKs.

Each word has a synthetic input `set_NAME`. Its one bits OR into storage on every normalized step while held. Use `i` or `7` to inject a status bit, then return the input to zero to stop reasserting it. These inputs represent explicit testing injections or a separately modeled peripheral's bit-set events; they are not assumed physical chip pins.

Choose **before** or **after** bus ordering during creation. With **before**, this tick's set bits appear in reads and may be overwritten/cleared by the same tick's bus access. With **after**, reads return the prior word and this tick's set bits survive a simultaneous write/read-clear. Select the order documented for your scenario; neither is inferred from a chip name. The scenario `reset` input dominates both, reloads every entered reset word, clears retained read data, and captures the current request token so release cannot replay a byte. It is not a specified chip reset domain.

The default demonstration injects set bits for non-`rw` words, writes an alternating pattern, and reads each address. Clear events with `a` for an experiment that starts from only the declared reset words. `U`/`R` undo/redo whole stimulus or register experiments. `S` saves a portable session, and `M` exports editable model JSON. To revise generated bank rules, create another bank with `c` or edit/review the exported JSON; `E` remains the behavior-table editor.

## RP2040 scratch storage from a real manual

```sh
npm start -- --document docs/references/rp2040/rp2040-datasheet.pdf
```

The manual initially opens the PIO example. Press `c`, choose Register bank, give the experiment a name, choose width **32**, and enter `@examples/rp2040-watchdog-scratch.registers.txt`. Its eight rows explicitly select relative offsets `0x0C` through `0x28` in four-byte steps, `rw`, zero reset words, and full 32-bit masks.

Cite **PDF page 549**, Table 549, using the exact excerpt `Information persists through soft reset of the chip.` Explain that this table supports the eight 32-bit RW scratch words and their reset values; inspect the offsets immediately above it. Declare that the selected experiment covers addressed word storage only. The source distinguishes soft-reset retention from other resets; this bank's synthetic `reset` reloads values, so it must not be used as an RP2040 soft reset. Watchdog countdown, reset domains, bootrom behavior, base addresses, atomic aliases, bus timing, and synthetic set-input fidelity remain outside this example.

After creation, clear demonstration events with `a`, press `u`, select SCRATCH0, choose Write, and enter `0xDEADBEEF` (or decimal `3735928559`). Read SCRATCH0 with `u` to observe the same 32-bit word. Writing SCRATCH1 leaves SCRATCH0 unchanged. `6` shows the named words and before/after changes; `3` logs addressed accesses. Values with bit 31 set remain unsigned in exports and numeric displays.

## Implementation and bounds

`src/model/register-bank/read.js` parses explicit rows without filesystem access. `build.js` generates bounded JSON actions and independent per-bit acceptance expectations, then uses the shared source/check gate in `builders/sourced.js`. `src/tui/register-bank-editor.js` owns prompts; `src/tui/authoring.js` shares bounded regular-file loading, retry behavior, and catalog-ID collision handling with the behavior-table editor. Imported model JSON never runs these trusted factories or arbitrary JavaScript.

Bounds are 16 words, 32-bit words/addresses, 64 KiB row files, and the existing trace/event limits. Balanced expression trees and one access transition per address keep a full bank inside the interpreter's nesting/transition limits. Generated checks cover each word's mode/mask, pre-side-effect reads, event ordering, initialization, reset priority, unmapped access, and held-token suppression. Independent regression oracles cover all byte values, 32-bit mixed operations, the actual RP2040 source page, terminal authoring/retries, sessions, both terminal sizes, browser import, and dwfv traces. These checks do not certify an unfamiliar chip's hardware behavior.
