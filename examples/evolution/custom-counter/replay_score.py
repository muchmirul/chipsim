"""Trusted bounded replay observer; checks the actual captured stimulus/history."""
import json
from pathlib import Path
import re
import sys


def score(kind, wave, case):
    if wave.get("format") != "chipsim-waveform" or wave.get("version") != 1:
        raise ValueError("Expected captured waveform")
    scales = {"s": 10**15, "ms": 10**12, "us": 10**9, "ns": 10**6, "ps": 1000, "fs": 1}
    scale = int(wave["timescale"]["magnitude"]) * scales[wave["timescale"]["unit"]]
    events = wave["events"]
    times = [int(e["time"]) * scale for e in events]
    if not events or len(events) > 20000 or any(a >= b for a, b in zip(times, times[1:])):
        raise ValueError("Incomplete or unordered replay")
    widths = {signal["id"]: signal["width"] for signal in wave["signals"]}
    values, cursor = {}, 0
    def sample(at):
        nonlocal cursor
        while cursor < len(events) and times[cursor] <= at:
            values.update(events[cursor]["changes"])
            cursor += 1
    def bits(name, width):
        if widths.get(name) != width or len(values.get(name, "")) != width:
            raise ValueError("Missing replay signal: " + name)
        return values[name]
    def integer(name, width):
        value = bits(name, width)
        return int(value, 2) if re.fullmatch("[01]+", value) else value
    if kind == "counter":
        cycle = case["cycle"]
        if type(cycle) is not int or not 0 <= cycle < 80 or times[-1] < (cycle + 1) * 10 * 10**6:
            raise ValueError("Incomplete counter prefix")
        expected = 0
        for i in range(cycle + 1):
            sample((i * 10 + 6) * 10**6)
            reset, enable = i in (0, 27, 55), i % 7 not in (3, 4)
            for name, value in (("clk", 1), ("reset", int(reset)), ("enable", int(enable))):
                if integer("counter_tb." + name, 1) != value:
                    raise ValueError("Changed counter replay history")
            expected = 0 if reset else (expected + int(enable)) % 16
        observed = bits("counter_tb.count", 4)
        mismatch = observed != format(expected, "04b")
    elif kind == "alu8":
        if times[-1] < 10**6:
            raise ValueError("Incomplete ALU replay")
        sample(10**6)
        inputs = case["inputs"]
        for name, width in (("A", 8), ("B", 8), ("opcode", 3)):
            if integer("alu_tb." + name, width) != inputs[name]:
                raise ValueError("Changed ALU replay inputs")
        from oracle import reference
        expected = reference(inputs["A"], inputs["B"], inputs["opcode"])
        observed = {key: integer("alu_tb." + key, 8 if key == "result" else 1)
                    for key in ("result", "carry", "zero", "overflow")}
        # Preserve the original compact observation encoding for unknown result bits.
        if isinstance(observed["result"], str):
            def nibble(v):
                return format(int(v, 2), "x") if re.fullmatch("[01]+", v) else "z" if set(v.lower()) == {"z"} else "x"
            observed["result"] = "".join(nibble(observed["result"][i:i+4]) for i in (0, 4))
        mismatch = expected != observed
    else:
        raise ValueError("Unknown replay observer")
    return {"format": "chipsim-evolution-replay", "version": 1,
            "reproduced": mismatch and expected == case["expected"] and observed == case["observed"],
            "expected": expected, "observed": observed,
            "scope": "Saved failure and necessary input history only; not full benchmark acceptance"}


if __name__ == "__main__":
    kind, wave_path, case_path, destination = sys.argv[1:]
    if Path(wave_path).stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Replay waveform exceeds limit")
    result = score(kind, json.loads(Path(wave_path).read_text()), json.loads(Path(case_path).read_text()))
    Path(destination).parent.mkdir(parents=True, exist_ok=True)
    Path(destination).write_text(json.dumps(result, indent=2) + "\n")
