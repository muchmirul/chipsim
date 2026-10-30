#!/usr/bin/env python3
"""Connected circuit rules, probes, source and native cursor in real terminals."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("CHIPSIM_NODE", "node")
CLI = str(ROOT / "scripts/chipsim.mjs")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
native = bool(shutil.which("iverilog") and shutil.which("vvp"))

for columns, rows in [(80, 24), (120, 40)]:
    with tempfile.TemporaryDirectory(prefix="chipsim-connected-pty-") as temporary:
        root = Path(temporary)
        command = [NODE, CLI, "circuit", "run" if native else "build",
                   str(ROOT / "examples/connected-circuit/swap.json"), "--out", str(root / "bundle")]
        if native:
            command += ["--stimulus", str(ROOT / "examples/connected-circuit/swap.stimulus.json")]
        built = subprocess.run(command, capture_output=True, text=True, cwd=ROOT, timeout=40)
        assert built.returncode == 0, built.stdout + built.stderr
        bundle = json.loads(built.stdout)
        (root / "probe.json").write_text(json.dumps({"state": {"A": 0, "B": 1},
            "inputs": {"clk": 1}, "previousClock": 0}))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        original = termios.tcgetattr(slave)
        process = subprocess.Popen([NODE, CLI, "--circuit", bundle["path"], "--workspace",
            str(root / "ui"), "--no-color"], cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        captured = ""
        def frame():
            return ANSI.sub("", captured[captured.rfind("\x1b[H"):]).replace("\r", "")
        def wait(text):
            global captured
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if text in frame():
                    return frame()
                if select.select([master], [], [], .05)[0]:
                    chunk = os.read(master, 65536)
                    if not chunk:
                        break
                    captured = (captured + chunk.decode("utf8", "replace"))[-500000:]
            raise AssertionError(f"Missing {text!r}:\n{frame()}")
        def send(text):
            global captured
            captured = ""
            os.write(master, text.encode())
        try:
            wait("ONE-STEP PROBE")
            assert not termios.tcgetattr(slave)[3] & termios.ICANON
            send("t"); wait("STATIC RULES")
            send("s"); wait("AUTHORITATIVE CONNECTED JSON")
            send("r"); wait("GENERATED SYSTEMVERILOG")
            send("e"); wait("event none")
            send("p"); wait("One-step snapshot JSON")
            send(str(root / "probe.json") + "\r")
            wait("Q 0b0 -> next Q 0b1")
            assert "sample 0/" in frame(), frame()
            if native:
                send("o"); wait("NATIVE sample 0")
                send("l"); wait("NATIVE sample 1")
                wait("agrees with one-step relation")
                send("1"); wait("sample 1/")
                send("O"); wait("NATIVE sample 1")
                send("e"); wait("ONE-STEP PROBE")
                assert "sample 1/" in frame(), frame()
            send("q")
            assert process.wait(timeout=5) == 0
            assert termios.tcgetattr(slave) == original
            print(f"connected circuit {columns}x{rows}: static/source/RTL, atomic probe, preserved native cursor={native}, terminal restoration passed")
        finally:
            if process.poll() is None:
                process.kill(); process.wait()
            os.close(master); os.close(slave)
