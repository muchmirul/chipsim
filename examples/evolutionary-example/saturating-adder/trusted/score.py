#!/usr/bin/env python3
"""Fixed oracle for the VCD-derived waveform, never candidate stdout/claims."""
import json
import re
import sys
from pathlib import Path

CYCLES = 256
MAX_WAVEFORM_BYTES = 8 * 1024 * 1024


def score(wave):
    if wave.get("format") != "chipsim-waveform" or wave.get("version") != 1:
        raise ValueError("expected ChipSim VCD-derived waveform")
    scale = wave["timescale"]
    unit_fs = {"s": 10**15, "ms": 10**12, "us": 10**9,
               "ns": 10**6, "ps": 1000, "fs": 1}
    tick_fs = int(scale["magnitude"]) * unit_fs[scale["unit"]]
    required = {"saturating_adder_tb.a": 4, "saturating_adder_tb.b": 4,
                "saturating_adder_tb.sum": 4}
    widths = {s["id"]: s["width"] for s in wave["signals"]}
    if any(widths.get(key) != width for key, width in required.items()):
        raise ValueError("missing or wrong-width observed interface")
    events = wave["events"]
    if not events or len(events) > 20000:
        raise ValueError("missing or oversized waveform")
    times = [int(e["time"]) * tick_fs for e in events]
    if any(a >= b for a, b in zip(times, times[1:])):
        raise ValueError("unordered waveform")
    if times[0] != 0 or times[-1] < CYCLES * 10 * 10**6:
        raise ValueError("incomplete harness duration")
    values, cursor, passed = {}, 0, 0
    failures = []
    for cycle in range(CYCLES):
        sample_fs = (cycle * 10 + 6) * 10**6
        while cursor < len(events) and times[cursor] <= sample_fs:
            values.update(events[cursor]["changes"])
            cursor += 1
        a, b = divmod(cycle, 16)
        # Check observed fixed inputs, not candidate-reported results.
        for key, value in (("a", a), ("b", b)):
            if values.get("saturating_adder_tb." + key) != format(value, "04b"):
                raise ValueError("harness stimulus missing or changed")
        expected = min(a + b, 15)
        bits = values.get("saturating_adder_tb.sum", "")
        actual = int(bits, 2) if re.fullmatch("[01]{4}", bits) else None
        if actual == expected:
            passed += 1
        elif len(failures) < 12:
            failures.append({"cycle": cycle, "a": a, "b": b,
                             "expected": expected, "observed": bits})
    return {"combined_score": passed / CYCLES, "checks_passed": passed,
            "checks_total": CYCLES, "failures": failures,
            "scope": "256 fixed sampled unsigned saturating-adder observations; no equivalence or PPA claim"}


def main():
    source, destination = map(Path, sys.argv[1:])
    if source.stat().st_size > MAX_WAVEFORM_BYTES:
        raise ValueError("waveform exceeds example scoring limit")
    result = score(json.loads(source.read_text()))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
