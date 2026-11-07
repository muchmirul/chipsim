"""Keep all clock/reset/enable history preceding the saved counter failure."""
import json
from pathlib import Path
case = json.loads(Path('replay-case.json').read_text())
cycle = case['cycle']
if type(cycle) is not int or not 0 <= cycle < 80:
    raise ValueError('Invalid cycle')
Path('prefix_tb.sv').write_text(Path('counter_tb.sv').read_text().replace('cycle < 80', f'cycle < {cycle + 1}'))
