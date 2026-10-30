#!/usr/bin/env python3
"""Exercise live external work reports, evidence review and cursor stability in a real TTY."""
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
CLI = str(ROOT / "scripts/chipsim.mjs")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

def cli(*args):
    result = subprocess.run([NODE, CLI, *map(str, args)], cwd=ROOT,
                            text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr + result.stdout
    return json.loads(result.stdout)

for columns, rows in [(80, 24), (120, 40)]:
    with tempfile.TemporaryDirectory(prefix="chipsim-live-work-pty-") as directory:
        project = Path(directory)
        # A deterministic recording fixture tests review, not hardware correctness.
        recording = subprocess.run(
            [NODE, "--input-type=module", "-e",
             "import {debugFixture} from './test/fixtures/hdl-debug.mjs'; console.log(JSON.stringify(debugFixture(20)));"],
            cwd=ROOT, text=True, capture_output=True, check=True, timeout=10).stdout
        (project / "recording.json").write_text(recording)
        (project / "capture.mjs").write_text(
            "import {mkdir,copyFile} from 'node:fs/promises'; "
            "await mkdir('out'); await copyFile('recording.json','out/debug.json'); "
            "console.log('Fixture recording published');")
        (project / "chipsim.design.json").write_text(json.dumps({
            "format": "chipsim-design", "version": 1, "id": "agent-work-pty",
            "tasks": {"capture": {"adapter": "command",
                "inputs": ["capture.mjs", "recording.json"],
                "options": {"command": NODE, "args": ["capture.mjs"]},
                "outputs": [{"path": "out/debug.json", "kind": "hdl-debug"}]}},
            "targets": {"review": {"tasks": ["capture"],
                "requiredChecks": ["capture:execution", "capture:outputs"]}}}))
        (project / "chipsim.lock.json").write_text(json.dumps({
            "format": "chipsim-lock", "version": 1, "dependencies": []}))
        run = cli("design", "run", "--project", project, "--wait")
        artifacts = cli("artifact", "list", "--project", project)
        debug_artifact = next(a for a in artifacts["artifacts"] if a["kind"] == "hdl-debug")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        original = termios.tcgetattr(slave)
        proc = subprocess.Popen([NODE, CLI, "--agent", str(project), "--workspace",
                                 str(project / "tui"), "--no-color"],
                                cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        captured = ""
        def frame():
            return ANSI.sub("", captured[captured.rfind("\x1b[H"):]).replace("\r", "")
        def wait(text, timeout=12):
            global captured
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                if text in frame():
                    return frame()
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    captured = (captured + chunk.decode("utf8", "replace"))[-500000:]
            raise AssertionError(f"Missing {text!r}:\n{frame()}")
        def send(text):
            global captured
            captured = ""
            os.write(master, text.encode())
        def publish(event):
            path = project / "event.json"
            path.write_text(json.dumps(event))
            cli("agent", "work-event", project, session, "--event", path)
        try:
            wait("No agent-work sessions yet")
            assert not termios.tcgetattr(slave)[3] & termios.ICANON
            started = cli("agent", "work-start", project, "--goal", "Counter live review", "--mode", "evolution")
            session = started["session"]["id"]
            wait("Counter live review")
            publish({"kind": "candidate", "candidate": "candidate-1", "generation": 0,
                     "status": "running", "message": "Implementing counter"})
            wait("Implementing counter")
            send("c")
            wait("CANDIDATES")
            wait("← root")
            publish({"kind": "candidate", "candidate": "unobserved",
                     "status": "running", "message": "Ancestry not supplied"})
            wait("← unknown")
            send("k")
            publish({"kind": "evaluation", "candidate": "candidate-1", "status": "passed",
                     "message": "Review recorded fixture", "metrics": {"cases": {"value": 4, "unit": "tests"}},
                     "evidence": {"project": str(project), "artifact": debug_artifact["id"]}})
            wait("cases=4")
            send("o")
            wait("EVIDENCE")
            send("\r")
            wait("HDL event replay")
            send("ll")
            current = wait("e2/19")
            publish({"kind": "tool", "status": "running", "message": "Background verification continues"})
            updated = wait("Background verification continues")
            assert "e2/19" in updated, updated
            assert "HDL event replay" in updated, updated
            # Resize during review, then return to the same live dashboard.
            new_columns, new_rows = ((120, 40) if columns == 80 else (80, 24))
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", new_rows, new_columns, 0, 0))
            proc.send_signal(signal.SIGWINCH)
            send("8eG")
            wait("Background verification continues")
            publish({"kind": "summary", "status": "completed", "message": "Review complete"})
            wait("Review complete")
            send("q")
            assert proc.wait(timeout=5) == 0
            assert termios.tcgetattr(slave) == original
            print(f"live agent work {columns}x{rows}: arriving session/events, candidate metrics, verified debug review, preserved cursor, resize and terminal restoration passed")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            os.close(master)
            os.close(slave)
