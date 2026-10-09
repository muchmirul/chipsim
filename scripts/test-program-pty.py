#!/usr/bin/env python3
"""Verify source stepping, breakpoints, replay and cleanup through a real TTY."""
import fcntl, json, os, pty, re, select, signal, struct, subprocess, tempfile, termios, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
with tempfile.TemporaryDirectory(prefix='chipsim-program-pty-') as workspace:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    original = termios.tcgetattr(slave)
    proc = subprocess.Popen([
        os.environ.get('CHIPSIM_NODE', 'node'), 'scripts/chipsim.mjs',
        '--workspace', workspace, '--no-color',
        '--document', str(ROOT/'docs/references/esp32-c6/espressif-esp32-c6-trm.pdf'),
        '--model', 'esp32c6-gpio', '--program', str(ROOT/'examples/esp32c6-gpio.chip')
    ], cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    captured = ''
    def frame():
        return ANSI.sub('', captured[captured.rfind('\x1b[H'):]).replace('\r', '')
    def wait(text, timeout=15):
        global captured
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if text in frame(): return frame()
            if select.select([master], [], [], .05)[0]:
                try: chunk = os.read(master, 65536)
                except OSError: break
                if not chunk: break
                captured = (captured + chunk.decode('utf8', 'replace'))[-500000:]
        raise AssertionError(f'Missing {text!r}:\n{frame()}')
    def send(keys):
        global captured
        captured = ''
        os.write(master, keys.encode())
    try:
        wait('EXPERIMENT SOURCE')
        assert not termios.tcgetattr(slave)[3] & termios.ICANON
        send('N'); wait('paused · tick 1 · next line 6')
        send('N'); wait('paused · tick 2 · next line 7')
        send('jjK'); wait('Breakpoint toggled on line 9')
        send('C'); wait('breakpoint · tick 5 · next line 9')
        send('N'); wait('paused · tick 6 · next line 10')
        send('J'); wait('paused · tick 5 · next line 9')
        send('G'); wait('VERIFIED PROGRAMMING GUIDES')
        send('\x1b'); wait('EXPERIMENT SOURCE')
        send('S'); wait('Save session path')
        session = Path(workspace)/'source-session.json'
        send(str(session)+'\r'); wait('Session saved.')
        saved = json.loads(session.read_text())
        assert saved['program']['steps'] == 4 and saved['duration'] == 5
        assert saved['program']['text'].startswith('# GPIO0')
        send('x'); wait('EXPORT FULL TRACE')
        send('j\r'); wait('Output path')
        trace = Path(workspace)/'program-trace.json'
        send(str(trace)+'\r'); wait('Saved '+str(trace))
        result = json.loads(trace.read_text())
        assert [s['signals']['selected_driver'] for s in result['trace']] == ['Z', 0, 1, 1, 1, 1]
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        proc.send_signal(signal.SIGWINCH)
        send('9'); wait('[PROGRAM]9')
        send('K'); wait('Breakpoint toggled on line 9')
        send('C'); wait('halted · tick 7 · next line end')
        send('r'); wait('Reset simulation.')
        send('Q'); wait('Program detached')
        send('q'); proc.wait(timeout=5)
        end = time.monotonic() + 1
        while time.monotonic() < end and select.select([master], [], [], .05)[0]:
            try: captured += os.read(master, 65536).decode('utf8', 'replace')
            except OSError: break
        assert proc.returncode == 0
        assert termios.tcgetattr(slave)[3] & (termios.ICANON|termios.ECHO) == original[3] & (termios.ICANON|termios.ECHO)
        assert '\x1b[?25h' in captured and '\x1b[?1049l' in captured
        print('Program PTY verified: source steps, breakpoint, replay, guide popup, saved source, signal oracle, 80×24/120×40, reset/detach and terminal cleanup.')
    finally:
        if proc.poll() is None: proc.terminate(); proc.wait(timeout=5)
        os.close(master); os.close(slave)
