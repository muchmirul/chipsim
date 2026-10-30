"""Measure observed output bit transitions, not physical power or area."""
import json
from pathlib import Path
import sys

source, destination = map(Path, sys.argv[1:])
if source.stat().st_size > 8 * 1024 * 1024:
    raise ValueError("waveform too large")
wave = json.loads(source.read_text())
previous, changes = None, 0
for event in wave["events"]:
    bits = event["changes"].get("counter_tb.count")
    if bits is None:
        continue
    if len(bits) != 4 or any(bit not in "01" for bit in bits):
        if previous is None:
            continue  # The counter initializes on its first synchronous reset.
        raise ValueError("counter output unavailable or unknown")
    if previous is not None:
        changes += sum(a != b for a, b in zip(previous, bits))
    previous = bits
if previous is None:
    raise ValueError("counter output missing")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps({
    "output_bit_changes": {"value": changes, "unit": "bit-transitions"},
    "scope": "Observed simulation activity after initialization; not physical power, area or timing",
}) + "\n")
