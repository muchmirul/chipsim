#!/usr/bin/env python3
"""Create and verify deterministic submission ZIPs without third-party libraries."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile


def main():
    root, output = Path(sys.argv[1]), Path(sys.argv[2])
    paths = sorted(p for p in root.rglob('*') if p.is_file())
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in paths:
            if path.is_symlink():
                raise ValueError('Symbolic links are not delivery files')
            info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError('ZIP CRC verification failed')
        if '--evidence' in sys.argv:
            manifest = json.loads(archive.read('bundle.json'))
            for member in manifest['objects']:
                data = archive.read('objects/' + member['sha256'])
                if len(data) != member['bytes'] or hashlib.sha256(data).hexdigest() != member['sha256']:
                    raise ValueError('Evidence object corrupted in archive')
        else:
            manifest = json.loads(archive.read('release-manifest.json'))
            for member in manifest['members']:
                data = archive.read(member['path'])
                if len(data) != member['bytes'] or hashlib.sha256(data).hexdigest() != member['sha256']:
                    raise ValueError('Archive member does not match release manifest: ' + member['path'])
            sums = archive.read('SHA256SUMS').decode().splitlines()
            for line in sums:
                expected, name = line.split('  ', 1)
                if hashlib.sha256(archive.read(name)).hexdigest() != expected:
                    raise ValueError('Archive checksum mismatch: ' + name)
    if len(sys.argv) > 3 and sys.argv[3] != '--evidence':
        destination = Path(sys.argv[3])
        destination.mkdir()
        with zipfile.ZipFile(output) as archive:
            archive.extractall(destination)
    print('Verified submission archive:', output)


if __name__ == '__main__':
    main()
