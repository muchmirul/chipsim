#!/usr/bin/env python3
"""Fixed oracle for the VCD-derived waveform, never candidate stdout/claims."""
import json
import re
import sys
from pathlib import Path

CYCLES = 80
MAX_WAVEFORM_BYTES = 8 * 1024 * 1024


def score(wave):
    if wave.get("format") != "chipsim-waveform" or wave.get("version") != 1:
        raise ValueError("expected ChipSim VCD-derived waveform")
    scale = wave["timescale"]
    unit_fs = {"s": 10**15, "ms": 10**12, "us": 10**9,
               "ns": 10**6, "ps": 1000, "fs": 1}
    tick_fs = int(scale["magnitude"]) * unit_fs[scale["unit"]]
    required = {"counter_tb.clk": 1, "counter_tb.reset": 1,
                "counter_tb.enable": 1, "counter_tb.count": 4}
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
    values, cursor, expected, passed = {}, 0, 0, 0
    failures = []
    for cycle in range(CYCLES):
        sample_fs = (cycle * 10 + 6) * 10**6
        while cursor < len(events) and times[cursor] <= sample_fs:
            values.update(events[cursor]["changes"])
            cursor += 1
        reset = cycle in (0, 27, 55)
        enable = cycle % 7 not in (3, 4)
        # Validate actual fixed stimulus, not just a candidate-reported result.
        for key, value in (("clk", 1), ("reset", int(reset)),
                           ("enable", int(enable))):
            if values.get("counter_tb." + key) != str(value):
                raise ValueError("harness stimulus missing or changed")
        expected = 0 if reset else (expected + int(enable)) % 16
        bits = values.get("counter_tb.count", "")
        actual = int(bits, 2) if re.fullmatch("[01]{4}", bits) else None
        if actual == expected:
            passed += 1
        elif len(failures) < 12:
            failures.append({"cycle": cycle, "expected": expected, "observed": bits})
    return {"combined_score": passed / CYCLES, "checks_passed": passed,
            "checks_total": CYCLES, "failures": failures,
            "scope": "80 fixed sampled counter observations; no equivalence or PPA claim"}


def main():
    source, destination = map(Path, sys.argv[1:])
    if source.stat().st_size > MAX_WAVEFORM_BYTES:
        raise ValueError("waveform exceeds example scoring limit")
    result = score(json.loads(source.read_text()))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
