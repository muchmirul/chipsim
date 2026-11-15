#!/usr/bin/env python3
"""Shared native precheck invocation for hardening and assembled deliveries."""
import json
import os
from pathlib import Path
import subprocess
import sys


def run_precheck(root, options, gds, support=None):
    root = Path(root)
    precheck_dir = Path(support or root / 'tt') / 'precheck'
    bindir = root / 'out/bin'
    bindir.mkdir(parents=True, exist_ok=True)
    klayout = bindir / 'klayout'
    docker = ['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}',
              '-v', f'{root}:{root}', '-v', f"{options['pdkRoot']}:{options['pdkRoot']}:ro",
              '-e', f"PDK_ROOT={options['pdkRoot']}", '-w', str(precheck_dir),
              '--entrypoint', 'klayout', options['image']]
    token = os.environ.get('CHIPSIM_JOB_TOKEN')
    if token:
        docker[2:2] = ['--label', 'chipsim.job=' + token]
    klayout.write_text("#!/usr/bin/env python3\nimport os, sys\nos.execvp('docker', " + repr(docker) + " + sys.argv[1:])\n")
    klayout.chmod(0o755)
    env = os.environ.copy()
    env['PATH'] = os.pathsep.join([str(bindir), str(Path(options['precheckPython']).parent), env.get('PATH', '')])
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['PDK_ROOT'] = options['pdkRoot']
    env['PDK'] = options['pdk']
    return subprocess.run([options['precheckPython'], str(precheck_dir / 'precheck.py'),
                           '--gds', str(gds), '--tech', options['pdk']], cwd=precheck_dir, env=env).returncode


if __name__ == '__main__':
    request = json.loads(Path(sys.argv[1]).read_text())
    root = Path(request.get('root', Path.cwd())).resolve()
    gds = Path(request['gds']).resolve()
    support = Path(request.get('support', root / 'tt')).resolve()
    raise SystemExit(run_precheck(root, request['options'], gds, support))
