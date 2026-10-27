#!/usr/bin/env python3
"""Exercise CSV-backed source, live stimulus replacement and terminal cleanup."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("CHIPSIM_NODE", "node")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

with tempfile.TemporaryDirectory(prefix="chipsim-csv-pty-") as temporary:
    root = Path(temporary)
    report = json.loads(subprocess.check_output([
        NODE, str(ROOT / "scripts/chipsim.mjs"), "table", "registers",
        str(ROOT / "examples/csv/registers.csv"), "--width", "32",
        "--priority", "after", "--name", "CSV terminal bank", "--out", str(root / "bank"),
    ], cwd=ROOT))
    bad = root / "bad.csv"
    bad.write_text("tick,signal,value\n1,read_data,1\n")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    original = termios.tcgetattr(slave)
    proc = subprocess.Popen([
        NODE, str(ROOT / "scripts/chipsim.mjs"), *report["tui"][1:],
        "--workspace", str(root / "workspace"), "--no-color",
    ], cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    captured = ""

    def frame():
        return ANSI.sub("", captured[captured.rfind("\x1b[H"):]).replace("\r", "")

    def wait(text, timeout=10):
        global captured
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if text in frame():
                return frame()
            if select.select([master], [], [], .05)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                captured = (captured + data.decode("utf8", "replace"))[-300000:]
        raise AssertionError(f"Missing {text!r}:\n{frame()}")

    def send(text):
        global captured
        captured = ""
        os.write(master, text.encode())

    try:
        wait("CSV terminal bank")
        send("4")
        wait("CSV source page 1/1")
        send("c")
        wait("Register bank")
        send("CSV guided bank\r")
        wait("word width")
        send("32\r")
        wait("Register rows")
        send("\r")
        wait("Synthetic hardware set")
        send("after\r")
        wait("Evidence CSV source page")
        send("\r")
        wait("Exact source excerpt")
        send("\r")
        wait("What the excerpt supports")
        send("\r")
        wait("Additional assumption")
        send("\r")
        wait("checks passed")
        send("1a")
        wait("Stimulus JSON array or JSON/CSV file path")
        send(str(ROOT / "examples/csv/stimulus.csv") + "\r")
        wait("Stimulus applied")
        send("t")
        wait("Go to normalized tick")
        send("5\r")
        wait("tick 5/")
        send("6")
        wait("CONTROL")
        # The source attachment and input transaction survive a bad CSV import.
        send("a")
        wait("JSON/CSV file path")
        send(str(bad) + "\r")
        wait("Unknown input signal read_data")
        send("U")
        wait("Stimulus undone")
        send("R")
        wait("Stimulus redone")
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        proc.send_signal(signal.SIGWINCH)
        send("4")
        wait("CSV source page 1/1")
        send("q")
        proc.wait(timeout=5)
        assert proc.returncode == 0
        restored = termios.tcgetattr(slave)
        assert restored[3] & (termios.ICANON | termios.ECHO) == original[3] & (termios.ICANON | termios.ECHO)
        print("CSV PTY verified: source attachment, guided register creation without PDF, live stimulus load, bad-file preservation, undo/redo, 120x40 and 80x24, terminal cleanup.")
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)
        os.close(master)
        os.close(slave)
