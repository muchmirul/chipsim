#!/usr/bin/env python3
"""Run the pinned container's digital tools with captured project files."""
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    o = json.loads(Path(sys.argv[1]).read_text())
    root = Path.cwd()
    def tool(command, *args):
        subprocess.run(['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}',
                        '-v', f'{root}:{root}', '-v', f"{o['pdkRoot']}:{o['pdkRoot']}:ro",
                        '-w', str(root), '--entrypoint', command, o['image'], *args], check=True)
    sources = o['sources']
    if o['operation'] == 'synthesis':
        # Inputs are validated as plain relative Verilog paths by ChipSim.
        script = 'read_verilog -sv -Isrc ' + ' '.join(sources) + '; synth -top ' + o['top'] + '; write_json synthesis.json; write_verilog synthesis.v'
        Path('synthesis.ys').write_text(script)
        tool('yosys', '-s', 'synthesis.ys')
        return
    args = ['-g2012', '-Isrc', '-s', 'tb', '-o', 'simulation.vvp']
    if o['operation'] == 'gate':
        cell = Path(o['pdkRoot']) / 'ihp-sg13cmos5l/libs.ref/sg13cmos5l_stdcell/verilog'
        sources = [str(cell / 'sg13cmos5l_stdcell.v'), str(cell / 'sg13cmos5l_udp.v'), 'gate_level_netlist.v']
        args += ['-DFUNCTIONAL', '-DSIM', '-DGL_TEST']
    tool('iverilog', *args, *sources, 'test/tb.sv')
    tool('vvp', 'simulation.vvp')


if __name__ == '__main__':
    main()
