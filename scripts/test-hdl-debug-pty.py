#!/usr/bin/env python3
"""Real terminal replay, linked panes, portable sessions and live cancellation."""
import fcntl, json, os, pty, re, select, signal, struct, subprocess, tempfile, termios, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get('CHIPSIM_NODE', 'node')
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
with tempfile.TemporaryDirectory(prefix='chipsim-debug-pty-') as directory:
    work = Path(directory)
    recording = json.loads(subprocess.check_output([NODE, 'scripts/chipsim.mjs', 'hdl', 'run',
        'examples/hdl/counter-verilog.project.json', '--debug', '--out', str(work/'recording')], cwd=ROOT, text=True))
    assert recording['ok'], recording
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    original = termios.tcgetattr(slave)
    proc = subprocess.Popen([NODE, 'scripts/chipsim.mjs', '--workspace', str(work/'workspace'), '--no-color',
        '--hdl-debug', recording['artifacts']['debug']], cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    captured = ''
    def frame():
        return ANSI.sub('', captured[captured.rfind('\x1b[H'):]).replace('\r', '')
    def wait(text, timeout=15, absent=None, columns=None):
        global captured
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if text in frame() and (absent is None or absent not in frame()) and (columns is None or len(frame().splitlines()[0]) == columns): return frame()
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
    def cursor():
        return int(re.search(r' · e(\d+)/', frame()).group(1))
    def same_cursor(index):
        text=frame()
        for name in ['HDL SOURCE','RTL HARDWARE','SIGNALS']:
            assert f'{name} · e{index}' in text, text
    def run(project, output):
        send('H');wait('HDL · SIGNAL WORKBENCH')
        send('jjj\r');wait('HDL project manifest JSON')
        send(str(project)+'\r');wait('New run output directory')
        send(str(output)+'\r')
    try:
        wait('◆ HDL SOURCE · e0'); same_cursor(0)
        assert '│' in frame()
        assert not termios.tcgetattr(slave)[3] & termios.ICANON
        send('l');wait('HDL SOURCE · e1');same_cursor(1)
        send('N');wait('HDL SOURCE · e2');same_cursor(2)
        send('J');wait('HDL SOURCE · e1');same_cursor(1)
        send('\x1bOQ');wait('◆ RTL HARDWARE · e1')  # F2
        send('\x1bOR');wait('◆ RTL HARDWARE · e1',absent='HDL SOURCE · e1')  # F3
        send('j');wait('◆ RTL HARDWARE · e1')
        send('\x1bOR');wait('HDL SOURCE · e1');same_cursor(1)
        for key,title in [('9','HDL SOURCE'),('2','RTL HARDWARE'),('1','SIGNALS')]:
            send(key);wait(f'{title} · e1');assert cursor()==1
        send('I');wait('HDL SOURCE · e1');same_cursor(1)
        # Stop on an actual process activation. C seeks; replay uses the same stop.
        send('K');wait('REPLAY STOPS')
        send('\r');wait('CHOOSE PROCESS')
        send('\r');wait('Replay stop added')
        send('C');wait('Replay stop matched at event')
        stopped=cursor();assert stopped>1;same_cursor(stopped)
        send('\r');wait('HDL DEBUG DETAILS')
        wait(f'Event: {stopped} (snapshot after event)')
        send('\x1b');wait(f'HDL SOURCE · e{stopped}',absent='HDL DEBUG DETAILS')
        send('G');wait('Source and hardware follow')
        send('F');wait('HDL SOURCE');assert cursor()==stopped
        send('+');wait('HDL SOURCE');assert cursor()==stopped
        send('S');wait('Save session path')
        session=work/'saved.json'
        send(str(session)+'\r');wait('Session saved.')
        saved=json.loads(session.read_text());assert saved['ui']['eventIndex']==stopped
        assert saved['ui']['stops'] and saved['ui']['focus']=='hardware'
        send('0');wait('HDL SOURCE · e0')
        send('H');wait('HDL · SIGNAL WORKBENCH')
        send('jjjj\r');wait('Debug recording / session JSON path')
        send(str(session)+'\r');wait(f'HDL SOURCE · e{stopped}');same_cursor(stopped)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        proc.send_signal(signal.SIGWINCH)
        send('I');wait(f'HDL SOURCE · e{stopped}',columns=80);same_cursor(stopped)
        assert not any('HDL SOURCE' in line and 'RTL HARDWARE' in line for line in frame().splitlines())
        send('?');wait('KEYS');wait('Capture:');send('\x1b');wait('HDL SOURCE')
        # Invalid import and a failing simulation preserve the current run/cursor.
        invalid=work/'invalid.json';invalid.write_text('{"format":"chipsim-hdl-debug","version":99}')
        send('H');wait('HDL · SIGNAL WORKBENCH');send('jjjj\r');wait('Debug recording / session JSON path')
        send(str(invalid)+'\r');wait('HDL debug: expected version-1');assert cursor()==stopped
        run(ROOT/'examples/hdl/counter-vhdl-fault.project.json',work/'fault');wait('HDL failed:')
        assert 'VERILOG counter handshake' in frame() and cursor()==stopped
        assert (work/'fault/debug.json').is_file()
        # Failed recordings can be deliberately opened, and display PARTIAL.
        send('H');wait('HDL · SIGNAL WORKBENCH');send('jjjj\r');wait('Debug recording / session JSON path')
        send(str(work/'fault/debug.json')+'\r');wait('PARTIAL · run');wait('VHDL counter handshake')
        same_cursor(0)
        send('x');wait('EXPORT FULL TRACE')
        send('j\r');wait('Output path')
        export=work/'export.json';send(str(export)+'\r');wait('Saved '+str(export))
        assert json.loads(export.read_text())['format']=='chipsim-hdl-debug'
        # Quit while recording: persist the partial artifact, restore raw mode.
        (work/'forever.sv').write_text('module tb; reg x=0; initial forever #1 x=~x; endmodule')
        project=work/'forever.json';project.write_text(json.dumps({'format':'chipsim-hdl-project','version':1,
            'language':'verilog','sources':['forever.sv'],'top':'tb'}))
        run(project,work/'cancelled');wait('HDL simulate');time.sleep(.1)
        send('q');proc.wait(timeout=10)
        data=json.loads((work/'cancelled/result.json').read_text())
        assert not data['ok'] and data['error']=='cancelled'
        assert not json.loads((work/'cancelled/debug.json').read_text())['status']['complete']
        end=time.monotonic()+1
        while time.monotonic()<end and select.select([master],[],[],.05)[0]:
            try:captured+=os.read(master,65536).decode('utf8','replace')
            except OSError:break
        assert proc.returncode==0
        assert termios.tcgetattr(slave)[3] & (termios.ICANON|termios.ECHO)==original[3] & (termios.ICANON|termios.ECHO)
        assert '\x1b[?25h' in captured and '\x1b[?1049l' in captured
        print('HDL debug PTY verified: synchronized panes, actual replay stops, source links, focus/expand, resize 120×40 → 80×24, portable session, partial import/export, failed-run preservation, cancellation and terminal cleanup.')
    finally:
        if proc.poll() is None:proc.terminate();proc.wait(timeout=10)
        os.close(master);os.close(slave)
