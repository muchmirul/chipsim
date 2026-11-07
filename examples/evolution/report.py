"""Seal an explicitly agent-reported evaluation summary as a managed artifact."""
import json
import shutil
from pathlib import Path
import sys

source, destination = map(Path, sys.argv[1:3])
if source.is_symlink() or source.stat().st_size > 262144:
    raise ValueError("invalid evaluation report")
report = json.loads(source.read_text())
if report.get("format") != "chipsim-evolution-evaluation" or report.get("version") not in (1, 2):
    raise ValueError("unsupported evaluation report")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
if len(sys.argv) == 4:
    shutil.copyfile(sys.argv[3], destination.parent / "inputs.json")
