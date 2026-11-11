#!/usr/bin/env python3
"""One explicit negative control; this is not a search or an evaluator."""
import pathlib, sys
root = pathlib.Path(__file__).resolve().parent
dut = root / 'rtl' / 'rv_fifo.sv'
backup = root / '.fifo-mutation-backup'
if sys.argv[1:] == ['apply']:
    original = dut.read_bytes()
    needle = b"2'b01: level <= level - 1'b1;"
    if original.count(needle) != 1:
        sys.exit('Expected the supplied FIFO occupancy case; no files changed.')
    with backup.open('xb') as f:
        f.write(original)
    dut.write_bytes(original.replace(needle, needle + b"\n                2'b11: level <= level + 1'b1; // intentional negative control"))
    print('Applied occupancy mutation. Run debug; expect cycle 13 to fail.')
elif sys.argv[1:] == ['restore']:
    dut.write_bytes(backup.read_bytes())
    backup.unlink()
    print('Restored exact pre-mutation source bytes.')
else:
    sys.exit('Usage: python3 mutate.py apply|restore')
