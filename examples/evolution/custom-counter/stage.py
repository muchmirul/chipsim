"""Adapt the independent counter oracle to the common stage report."""
import json
from pathlib import Path
from oracle import score

report = score(json.loads(Path('waveform.json').read_text()))
cases = [{"check": "counter recurrence", "cycle": f["cycle"],
          "inputs": {"cycle": f["cycle"], "reset": int(f["cycle"] in (0, 27, 55)), "enable": int(f["cycle"] % 7 not in (3, 4))},
          "expected": f["expected"], "observed": f["observed"]} for f in report['failures']]
Path('out').mkdir(exist_ok=True)
Path('out/stage.json').write_text(json.dumps({"format": "chipsim-evolution-stage", "version": 1,
    "metrics": {k: report[k] for k in ('combined_score', 'checks_passed', 'checks_total')},
    "cases": cases}) + '\n')
