#!/usr/bin/env python3
"""Real ChipSim child terminal I/O through the native slash-command adapter."""
import fcntl, os, pty, select, struct, subprocess, tempfile, termios, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("CHIPSIM_NODE", "node")
for columns, rows in [(80, 24), (120, 40)]:
    for host in ["pi", "prime"]:
        with tempfile.TemporaryDirectory(prefix="chipsim-agent-handoff-") as cwd:
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            original = termios.tcgetattr(slave)
            proc = subprocess.Popen([NODE, str(ROOT / "test/fixtures/agent-extension-handoff.mjs"), host],
                                    cwd=cwd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
            captured = b""
            def wait_for(text, timeout=12):
                global captured
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    if text in captured:
                        return
                    if select.select([master], [], [], 0.05)[0]:
                        chunk = os.read(master, 65536)
                        if not chunk:
                            break
                        captured += chunk
                raise AssertionError(f"Missing {text!r}: {captured[-12000:]!r}")
            try:
                wait_for(b"CHIPSIM")
                assert not termios.tcgetattr(slave)[3] & termios.ICANON
                os.write(master, b"g")
                wait_for(b"Current:")
                os.write(master, b"1")
                wait_for(b"DATA")
                os.write(master, b"q")
                wait_for(b"HOST_RESUMED raw=true")
                wait_for(b"HANDOFF_COMPLETE")
                assert proc.wait(timeout=5) == 0
                assert termios.tcgetattr(slave) == original
                assert b"\x1b[?25h" in captured
                print(f"{host} handoff {columns}x{rows}: states/signals, q return, host resume and terminal restoration passed")
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                os.close(master)
                os.close(slave)
