#!/usr/bin/env python3
"""Static netlist inspection must never display or operate a hidden simulation."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("CHIPSIM_NODE", "node")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

for columns, rows in [(80, 24), (120, 40)]:
    with tempfile.TemporaryDirectory(prefix="chipsim-netlist-pty-") as temporary:
        root = Path(temporary)
        netlist = root / "netlist.json"
        netlist.write_text(json.dumps({"modules": {"top": {
            "ports": {"q": {"direction": "output", "bits": [2]}}
        }}}))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        original = termios.tcgetattr(slave)
        process = subprocess.Popen([
            NODE, str(ROOT / "scripts/chipsim.mjs"), "--netlist", str(netlist),
            "--workspace", str(root / "ui"), "--no-color"
        ], cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
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
            while select.select([master], [], [], 0)[0]:
                os.read(master, 65536)
            captured = ""
            os.write(master, text.encode())

        try:
            wait("SCHEMATIC")
            assert not termios.tcgetattr(slave)[3] & termios.ICANON
            for key in ["1", "9", "g", "I", " ", "r", "S", "x", "p", "P", "t"]:
                send(key)
                text = wait("Static netlist:")
                assert "SCHEMATIC" in text and "synthesized netlist" in text, text
                assert "DATA" not in text and "Selected: data" not in text, text
                assert "Save session path" not in text, text
            send("m")
            wait("MODELS")
            send("\r")
            text = wait("tick 0/")
            assert "synthesized netlist" not in text and "Selected:" in text, text
            send("q")
            assert process.wait(timeout=5) == 0
            assert termios.tcgetattr(slave) == original
            print(f"netlist {columns}x{rows}: static shortcuts, explicit model exit and terminal restoration passed")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
            os.close(slave)
