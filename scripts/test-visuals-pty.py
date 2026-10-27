#!/usr/bin/env python3
"""Exercise state/flow/reference views through real PTYs at both supported sizes."""
import fcntl, json, os, pty, re, select, struct, subprocess, tempfile, termios, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
for columns, rows in [(80, 24), (120, 40)]:
    with tempfile.TemporaryDirectory(prefix='chipsim-visuals-pty-') as workspace:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        original = termios.tcgetattr(slave)
        parameters = Path(workspace)/'parameters.json'
        parameters.write_text(json.dumps({'payload': 2}))
        missing = Path(workspace)/'missing.json'
        missing.write_text(json.dumps({'format': 'chipsim-session', 'version': 1, 'modelId': 'pio', 'model': None, 'parameters': {'payload': 2, 'ack': 'missing'}, 'inputs': [], 'duration': 100, 'tick': 40, 'display': 'hex'}))
        proc = subprocess.Popen([os.environ.get('CHIPSIM_NODE', 'node'), 'scripts/chipsim.mjs', '--workspace', workspace, '--params', str(parameters), '--model', 'pio', '--view', 'states', '--at', '32', '--no-color'], cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        captured = ''
        def frame():
            return ANSI.sub('', captured[captured.rfind('\x1b[H'):]).replace('\r', '')
        def wait(text):
            global captured
            end = time.monotonic() + 10
            while time.monotonic() < end:
                if text in frame(): return frame()
                if select.select([master], [], [], .05)[0]:
                    try: data = os.read(master, 65536)
                    except OSError: break
                    captured = (captured + data.decode('utf8', 'replace'))[-500000:]
            raise AssertionError(f'Missing {text!r} at {columns}x{rows}:\n{frame()}')
        def send(keys):
            global captured
            captured = ''
            os.write(master, keys.encode())
        try:
            wait('Current: wait · Focus: wait')
            assert 'timeout' in frame() and 'success' in frame() and '──→' in frame()
            send('\r'); wait('STATE wait')
            send('\x1b'); wait('Current: wait · Focus: wait')
            send('vrll'); wait('CAPTURE bit 0')
            assert 'DATA [0]' in frame() and '1/8 samples' in frame()
            send('Y'); wait('Reference captured')
            send('D'); wait('0 differing ticks')
            send('d'); wait('Import PDF, CSV source, model/session JSON, or VCD')
            send(str(missing)+'\r'); wait('first 35')
            assert 'success' in frame() and 'timeout' in frame()
            send('r]'); wait('tick 35/59')
            send('\r'); wait('EXPERIMENT COMPARISON')
            send('jj\r'); wait('Comparison JSON path')
            report = Path(workspace)/'comparison.json'
            send(str(report)+'\r'); wait('Experiment comparison exported')
            exported = json.loads(report.read_text())
            assert exported['reference']['session']['parameters']['ack'] == 'present'
            assert exported['current']['session']['parameters']['ack'] == 'missing'
            assert exported['comparison']['firstDifference'] == 35
            send('gv'); wait('BIT FLOW')
            send('q'); proc.wait(timeout=5)
            assert proc.returncode == 0
            assert termios.tcgetattr(slave)[3] & (termios.ICANON|termios.ECHO) == original[3] & (termios.ICANON|termios.ECHO)
        finally:
            if proc.poll() is None: proc.terminate(); proc.wait(timeout=5)
            os.close(master); os.close(slave)
print('PTY verified: FSM branches/rules, zero-bit capture, immutable reference, session load, difference navigation/report export and terminal cleanup at 80x24 and 120x40.')
