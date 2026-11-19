"""Extract a bounded ChipSim evidence ZIP to an empty staging directory."""
import pathlib
import re
import shutil
import sys
import zipfile

archive, destination = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(archive) as bundle:
    members = bundle.infolist()
    names = {entry.filename for entry in members}
    if (len(names) != len(members) or len(members) > 40001 or
            'bundle.json' not in names or sum(e.file_size for e in members) > 2**31):
        raise ValueError('Invalid evidence ZIP inventory')
    for entry in members:
        if not re.fullmatch(r'bundle\.json|objects/[a-f0-9]{64}|records/[a-f0-9]{64}\.json', entry.filename):
            raise ValueError('Unexpected evidence member')
        target = destination / entry.filename
        target.parent.mkdir(exist_ok=True, parents=True)
        with bundle.open(entry) as source, target.open('xb') as out:
            shutil.copyfileobj(source, out, 65536)
