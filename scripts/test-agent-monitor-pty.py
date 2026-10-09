#!/usr/bin/env python3
"""Observe real agent processes in a concurrently running terminal monitor."""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("CHIPSIM_NODE", "node")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

with tempfile.TemporaryDirectory(prefix="chipsim-monitor-pty-") as temporary:
    folder = Path(temporary)
    project = folder / "agent project"

    def agent(*args):
        result = subprocess.run(
            [NODE, "scripts/chipsim.mjs", "agent", *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        report = json.loads(result.stdout)
        assert result.returncode == 0 and report["ok"], report
        assert result.stderr == "", result.stderr
        return report

    prepared = agent("prepare", ROOT / "docs/references/74hc00/nexperia-74hc00.pdf", "--out", project)
    model = project / prepared["models"][0]["file"]
    spec = json.loads(model.read_text())
    model_id = spec["id"]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen(
        [NODE, "scripts/chipsim.mjs", "--watch", str(project), "--workspace", str(folder / "viewer"), "--no-color"],
        cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
    )
    captured = ""

    def frame():
        return ANSI.sub("", captured[captured.rfind("\x1b[H"):]).replace("\r", "")

    def wait(text, timeout=8):
        global captured
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if text in frame():
                return frame()
            if select.select([master], [], [], .05)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                captured = (captured + chunk.decode("utf8", "replace"))[-500000:]
        raise AssertionError(f"Missing {text!r} in terminal:\n{frame()}")

    def send(text):
        global captured
        captured = ""
        os.write(master, text.encode())

    def run(name, title, ticks):
        spec["name"] = title
        scratch = model.with_suffix(".tmp")
        scratch.write_text(json.dumps(spec))
        scratch.replace(model)
        return agent("run", model, "--project", project, "--out", folder / name, "--ticks", ticks)

    try:
        wait("Agent activity · WATCH LIVE")
        assert not termios.tcgetattr(slave)[3] & termios.ICANON
        agent("note", project, "Reviewing source before the first experiment")
        wait("Reviewing source before")
        run("first", "Agent's first experiment", 20)
        wait(f"Loaded {model_id} · 20 ticks")
        assert "Agent's first experiment" in frame()
        send("6t")
        wait("Go to normalized tick")
        send("12\rF")
        wait("tick 12/20  state logic  format decimal")
        send("W")
        wait("WATCH PAUSED")
        run("short", "Agent's shorter experiment", 5)
        wait("AGENT · run succeeded")
        assert "Agent's first experiment" in frame()
        assert "tick 12/20" in frame()
        send("W")
        wait("Agent's shorter experiment")
        assert "tick 5/5" in frame() and "format decimal" in frame()
        assert re.search(r"\[REGISTERS\]\s?6", frame()), frame()
        send("t")
        wait("Go to normalized tick")
        run("third", "Agent's third experiment", 10)
        wait("AGENT · run succeeded")
        assert "Go to normalized tick" in frame()
        assert "Agent's shorter experiment" in frame()
        send("\x1b")
        wait("Agent's third experiment")
        assert "tick 5/10" in frame() and "format decimal" in frame()
        agent("page", project, 1, "--limit", 20)
        wait("Read PDF page 1")
        send("8")
        wait("Agent activity")
        send("k")
        wait("browsing")
        send("G")
        wait("following")
        send("/")
        wait("Filter agent activity")
        send("Read PDF page\r")
        wait("Read PDF page 1")
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        process.send_signal(signal.SIGWINCH)
        wait("Agent activity")
        send("q")
        process.wait(timeout=5)
        end = time.monotonic() + 1
        while time.monotonic() < end and select.select([master], [], [], .05)[0]:
            try:
                captured += os.read(master, 65536).decode("utf8", "replace")
            except OSError:
                break
        assert process.returncode == 0
        restored = termios.tcgetattr(slave)
        assert restored[3] & (termios.ICANON | termios.ECHO) == original[3] & (termios.ICANON | termios.ECHO)
        assert "\x1b[?25h" in captured and "\x1b[?1049l" in captured
        print("Agent monitor PTY verified: concurrent commands, source activity, atomic model edits, automatic run loading, view/cursor/base preservation, pause/resume, prompt deferral, filtering, follow, resize, and terminal cleanup.")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)
