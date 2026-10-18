#!/usr/bin/env python3
"""Real TUI graph navigation, resize, artifact opening and terminal restoration."""
import fcntl, json, os, pty, re, select, shutil, signal, struct, subprocess, tempfile, termios, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("CHIPSIM_NODE", "node")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
with tempfile.TemporaryDirectory(prefix="chipsim-design-pty-") as directory:
    work = Path(directory)
    project = work / "project"
    shutil.copytree(ROOT / "examples/design/peripheral", project, ignore=shutil.ignore_patterns(".chipsim"))
    run = json.loads(subprocess.check_output([NODE, str(ROOT / "scripts/chipsim.mjs"), "design", "run", "--project", str(project), "--wait"], text=True))
    assert run["job"]["ready"], run
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    proc = subprocess.Popen([NODE, "scripts/chipsim.mjs", "--design", str(project), "--workspace", str(work / "workspace"), "--no-color"], cwd=ROOT, stdin=slave, stdout=slave, stderr=slave)
    captured = ""

    def frame():
        return ANSI.sub("", captured[captured.rfind("\x1b[H"):]).replace("\r", "")

    def wait(text, timeout=20, columns=None):
        global captured
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if text in frame() and (columns is None or len(frame().splitlines()[0]) == columns):
                return frame()
            if select.select([master], [], [], .05)[0]:
                try:
                    captured = (captured + os.read(master, 65536).decode("utf8", "replace"))[-500000:]
                except OSError:
                    break
        raise AssertionError(f"Missing {text!r}:\n{frame()}")

    def send(keys):
        global captured
        captured = ""
        os.write(master, keys.encode())

    try:
        wait("PROJECT · versioned")
        send("\t"); wait("PIPELINE · versioned"); wait("COMPLETED")
        send("\t"); wait("ARTIFACTS · versioned")
        send("\r"); wait("Inspect payload")
        send("jj\r"); wait('"artifact"')
        send("\x1b"); wait("j/k select · Enter actions")
        send("\t"); wait("CHECKS · versioned"); wait("READY")
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        proc.send_signal(signal.SIGWINCH)
        send("0"); wait("PROJECT · versioned", columns=80)
        assert len(frame().splitlines()[0]) == 80
        send("r"); wait("Accepted ")
        send("q"); proc.wait(timeout=10)
        assert proc.returncode == 0
        restored = termios.tcgetattr(slave)
        assert restored[3] & (termios.ICANON | termios.ECHO) == original[3] & (termios.ICANON | termios.ECHO)
        saved = json.loads((project / ".chipsim/design/sessions/tui.json").read_text())
        assert saved["format"] == "chipsim-inspection-session"
        print("Design PTY verified: project/pipeline/artifact/check navigation, metadata, 120x40 and 80x24, session persistence and terminal restoration.")
    finally:
        if proc.poll() is None:
            proc.terminate(); proc.wait(timeout=10)
        os.close(master); os.close(slave)
