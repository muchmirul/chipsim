#!/usr/bin/env python3
"""Real terminal HDL import/run/compare/export and cleanup, at both sizes."""
import fcntl, json, os, pty, re, select, signal, struct, subprocess, tempfile, termios, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get('CHIPSIM_NODE', 'node')
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
with tempfile.TemporaryDirectory(prefix='chipsim-hdl-pty-') as directory:
    work = Path(directory)
    vhdl = json.loads(subprocess.check_output([
        NODE, 'scripts/chipsim.mjs', 'hdl', 'run',
        'examples/hdl/adder-vhdl.project.json', '--out', str(work/'vhdl')
    ], cwd=ROOT, text=True))
    assert vhdl['ok'], vhdl
    recorded = work/'recorded.vcd'
    recorded.write_text('$timescale 1ns $end\n$var wire 1 a out $end\n$enddefinitions $end\n0a\n#50\n1a\n#100\n')
    mismatch = work/'mismatch.vcd'
    mismatch.write_text(recorded.read_text().replace('1a', '0a'))
    mapping = work/'mapping.json'
    mapping.write_text(json.dumps({'signals': [{'left': 'out', 'right': 'out'}]}))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    original = termios.tcgetattr(slave)
    proc = subprocess.Popen([NODE, 'scripts/chipsim.mjs', '--workspace', str(work/'workspace'), '--no-color'],
        cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    captured = ''
    def frame():
        return ANSI.sub('', captured[captured.rfind('\x1b[H'):]).replace('\r', '')
    def wait(text, timeout=15, absent=None):
        global captured
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if text in frame() and (absent is None or absent not in frame()): return frame()
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
    def compare(path, map_path):
        send('H'); wait('HDL · SIGNAL WORKBENCH')
        send('jj\r'); wait('Comparison VCD')
        send(str(path)+'\r'); wait('Signal/time mapping JSON')
        send(str(map_path)+'\r'); wait('HDL COMPARISON')
    def run(project, out):
        send('H'); wait('HDL · SIGNAL WORKBENCH')
        send('j\r'); wait('HDL project manifest JSON')
        send(str(project)+'\r'); wait('New run output directory')
        send(str(out)+'\r'); wait(json.loads(project.read_text())['name']); wait('HDL waveform loaded')
    try:
        wait('CHIPSIM')
        assert not termios.tcgetattr(slave)[3] & termios.ICANON
        send('H'); wait('HDL · SIGNAL WORKBENCH')
        send('\r'); wait('VCD / waveform JSON path')
        send(str(recorded)+'\r'); wait('HDL waveform replay')
        send('l'); wait('sample 1/2 · time 50 ns')
        send('\r'); wait('Simulator time 50 ns')
        send('\x1b'); wait('HDL waveform replay')
        send('S'); wait('Save session path')
        session = work/'recorded-session.json'
        send(str(session)+'\r'); wait('Session saved.')
        saved = json.loads(session.read_text())
        assert saved['format'] == 'chipsim-waveform-session' and saved['tick'] == 1
        compare(mismatch, mapping)
        wait('DIFFERENT · 2/3 changed samples')
        send('jjj\r'); wait('Comparison output JSON')
        report = work/'mismatch-report.json'
        send(str(report)+'\r'); wait('HDL COMPARISON')
        assert not json.loads(report.read_text())['match']
        send('\x1b'); wait('sample 1/2 · time 50 ns', absent='HDL COMPARISON')
        run(ROOT/'examples/hdl/adder-verilog.project.json', work/'verilog')
        compare(Path(vhdl['artifacts']['vcd']), ROOT/'examples/hdl/adder-compare.json')
        wait('MATCH · 0/256 changed samples')
        send('\x1b'); wait('HDL waveform replay', absent='HDL COMPARISON')
        send('x'); wait('EXPORT FULL TRACE')
        send('j\r'); wait('Output path')
        export = work/'verilog-waveform.json'
        send(str(export)+'\r'); wait('Saved '+str(export))
        wave = json.loads(export.read_text())
        assert wave['format'] == 'chipsim-waveform'
        assert wave['origin']['project']['language'] == 'verilog'
        assert any(e['changes'].get('adder_tb.logic_probe') == '10XZ' for e in wave['events'])
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        proc.send_signal(signal.SIGWINCH)
        send('6'); wait('adder_tb.')
        run(ROOT/'examples/hdl/adder-vhdl.project.json', work/'vhdl-terminal')
        wait('Open-source VHDL adder')
        # A failed run must leave this active waveform intact.
        bad = work/'bad.project.json'
        (work/'bad.v').write_text('invalid syntax')
        bad.write_text(json.dumps({'format': 'chipsim-hdl-project', 'version': 1, 'language': 'verilog', 'sources': ['bad.v'], 'top': 'tb'}))
        send('H'); wait('HDL · SIGNAL WORKBENCH')
        send('j\r'); wait('HDL project manifest JSON')
        send(str(bad)+'\r'); wait('New run output directory')
        send(str(work/'failed')+'\r'); wait('HDL failed:')
        assert 'Open-source VHDL adder' in frame()
        assert not json.loads((work/'failed/result.json').read_text())['ok']
        # Quitting while a live simulator runs must persist its cancelled result
        # before the parent process exits, as well as restoring terminal mode.
        (work/'infinite.v').write_text('`timescale 1ns/1ps\nmodule tb; reg x=0; initial begin $dumpfile("trace.vcd"); $dumpvars(0,tb); #1; x=1; forever #1; end endmodule')
        infinite = work/'infinite.project.json'
        infinite.write_text(json.dumps({'format': 'chipsim-hdl-project', 'version': 1, 'language': 'verilog', 'sources': ['infinite.v'], 'top': 'tb'}))
        send('H'); wait('HDL · SIGNAL WORKBENCH')
        send('j\r'); wait('HDL project manifest JSON')
        send(str(infinite)+'\r'); wait('New run output directory')
        send(str(work/'cancelled')+'\r'); wait('HDL simulate')
        send('q'); proc.wait(timeout=5)
        cancelled = json.loads((work/'cancelled/result.json').read_text())
        assert not cancelled['ok'] and cancelled['error'] == 'cancelled'
        end = time.monotonic() + 1
        while time.monotonic() < end and select.select([master], [], [], .05)[0]:
            try: captured += os.read(master, 65536).decode('utf8', 'replace')
            except OSError: break
        assert proc.returncode == 0
        assert termios.tcgetattr(slave)[3] & (termios.ICANON|termios.ECHO) == original[3] & (termios.ICANON|termios.ECHO)
        assert '\x1b[?25h' in captured and '\x1b[?1049l' in captured
        print('HDL PTY verified: VCD import, exact time/details, saved session, discrepancy/export, real Verilog/VHDL runs and matched comparison, mixed logic export, 80×24/120×40, failed-run preservation, live cancellation artifacts and terminal cleanup.')
    finally:
        if proc.poll() is None: proc.terminate(); proc.wait(timeout=5)
        os.close(master); os.close(slave)
