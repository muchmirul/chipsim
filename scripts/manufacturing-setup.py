#!/usr/bin/env python3
"""Explicit pinned user-cache installation, invoked by a managed ChipSim job."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def run(*args, **kwargs):
    print('Run:', *args, flush=True)
    subprocess.run(args, check=True, **kwargs)


def ensure_image(image):
    command = ['docker', 'image', 'inspect', image]
    found = subprocess.run(command, capture_output=True, text=True)
    if found.returncode:
        run('docker', 'pull', image)
        found = subprocess.run(command, check=True, capture_output=True, text=True)
    details, = json.loads(found.stdout)
    if (image not in (details.get('RepoDigests') or []) or
            (details.get('Os'), details.get('Architecture')) != ('linux', 'amd64')):
        raise ValueError('Docker image differs from the pinned digest or platform')


def unpack(source, destination):
    # GitHub archives have one prefix. Extract to staging using the stdlib's
    # data filter; absolute/traversal links and special files are rejected.
    with tempfile.TemporaryDirectory(dir=destination.parent) as temp:
        with tarfile.open(source, 'r:gz') as archive:
            archive.extractall(temp, filter='data')
        entries = list(Path(temp).iterdir())
        if len(entries) != 1 or not entries[0].is_dir():
            raise ValueError('Expected single-root source archive')
        os.rename(entries[0], destination)


def verify_source_tree(source, destination, profile):
    expected = set()
    with tarfile.open(source, 'r:gz') as archive:
        for member in archive:
            parts = Path(member.name).parts[1:]
            if not parts or member.isdir():
                continue
            relative = Path(*parts)
            expected.add(relative.as_posix())
            path = destination / relative
            if member.issym():
                if not path.is_symlink() or os.readlink(path) != member.linkname:
                    raise ValueError('Cached source link changed: ' + str(path))
            elif member.isfile():
                if path.is_symlink() or not path.is_file():
                    raise ValueError('Cached source file missing: ' + str(path))
                h = hashlib.sha256()
                with archive.extractfile(member) as stream:
                    while data := stream.read(1024 * 1024):
                        h.update(data)
                if digest(path) != h.hexdigest():
                    raise ValueError('Cached source file changed: ' + str(path))
            else:
                raise ValueError('Unsupported source archive member: ' + member.name)
    generated = profile['pdk'] + '/SOURCES' if destination.name == 'pdk' else None
    actual = {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file() or p.is_symlink()}
    if actual - expected - ({generated} if generated else set()):
        raise ValueError('Unexpected files in cached source tree: ' + str(destination))


def main():
    os.environ.setdefault('GIT_PYTHON_REFRESH', 'quiet')
    request = json.loads(Path(sys.argv[1]).read_text())
    profile, cache = request['profile'], Path(request['cache'])
    if sys.platform != 'linux' or os.uname().machine != 'x86_64':
        raise ValueError('This profile requires Linux x86-64')
    if not ((3, 11) <= sys.version_info[:2] <= (3, 12)):
        raise ValueError('The pinned Python package set requires Python 3.11 or 3.12')
    run('docker', 'info', '--format', '{{.OSType}} {{.Architecture}}')
    cache.mkdir(parents=True, exist_ok=True)
    with (cache / 'setup.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ensure_image(profile['pins']['image'])
        downloads = cache / 'downloads'
        downloads.mkdir(exist_ok=True)
        for name, source in profile['sources'].items():
            print('Verify source:', name, source['revision'], flush=True)
            archive = downloads / (source['sha256'] + '.tar.gz')
            if not archive.exists() or digest(archive) != source['sha256']:
                partial = archive.with_suffix('.partial')
                with urllib.request.urlopen(source['url'], timeout=120) as r, partial.open('wb') as f:
                    size = 0
                    while data := r.read(1024 * 1024):
                        size += len(data)
                        if size > 1024 ** 3:
                            raise ValueError('Source download exceeds 1 GiB')
                        f.write(data)
                if digest(partial) != source['sha256']:
                    raise ValueError('Source SHA-256 mismatch: ' + name)
                os.replace(partial, archive)
            destination = cache / name
            if not destination.exists():
                unpack(archive, destination)
            verify_source_tree(archive, destination, profile)
        pdk = cache / 'pdk' / profile['pdk']
        (pdk / 'SOURCES').write_text('IHP-Open-PDK ' + profile['pins']['pdkRevision'] + '\n')
        for name in ['support', 'precheck']:
            env = cache / (name + '-venv')
            checker = str(Path(__file__).with_name('manufacturing_python.py'))
            python = str(env / 'bin/python')
            if env.exists():
                try:
                    valid = subprocess.run([python, checker, request['locks'][name]], check=False).returncode == 0
                except OSError:
                    valid = False
                if not valid:
                    print('Repair incomplete or altered managed environment:', env, flush=True)
                    shutil.rmtree(env)
            if not env.exists():
                run(sys.executable, '-m', 'venv', '--copies', str(env))
            run(python, '-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes',
                '--only-binary=:all:', '-r', request['locks'][name])
            run(python, checker, request['locks'][name])
            run(python, '-m', 'pip', 'check')
            modules = ('librelane, yaml, klayout.db, chevron, git' if name == 'support'
                       else 'klayout.db, gdstk, pytest, yaml')
            run(python, '-c', 'import ' + modules)
        run(str(cache / 'support-venv/bin/python'), '-c',
            'import sys; sys.path.insert(0, sys.argv[1]); from tinytapeout_project import load_project; load_project(sys.argv[2])',
            str(Path(__file__).resolve().parent), str(cache / 'support'))
        # Real tools, rather than an installation receipt, establish usability.
        image = profile['pins']['image']
        for command in [['iverilog', '-V'], ['yosys', '-V'], ['klayout', '-v']]:
            run('docker', 'run', '--rm', '--entrypoint', command[0], image, *command[1:])
        Path(request['output']).write_text(json.dumps({'cache': str(cache), 'profile': profile['id'],
            'digest': profile['digest'], 'python': str(cache / 'support-venv/bin/python'),
            'precheckPython': str(cache / 'precheck-venv/bin/python'), 'pdkRoot': str(cache / 'pdk'),
            'template': str(cache / 'template'), 'support': str(cache / 'support')}))


if __name__ == '__main__':
    main()
