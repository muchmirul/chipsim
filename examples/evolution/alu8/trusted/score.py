"""Stream bounded actual observations; never trust candidate pass/fail claims."""
import json
from pathlib import Path
import re
import sys

from oracle import COUNTS, SEED, reference, vector_bytes, vectors, fingerprint


def score(stage, source):
    source = Path(source)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("expected bounded regular observations file")
    per_op = [{"passed": 0, "total": 0} for _ in range(8)]
    failures = []
    passed = total = 0
    with source.open() as stream:
        for index, (a, b, op) in enumerate(vectors(stage)):
            row = stream.readline(128).strip().split()
            stimulus = f"{(a << 11) | (b << 3) | op:05x}"
            if len(row) != 3 or row[0].lower() != stimulus or not re.fullmatch(r"[0-9a-fA-FxXzZ]{2}", row[1]) or not re.fullmatch(r"[01xXzZ]{3}", row[2]):
                raise ValueError(f"missing, malformed or changed stimulus at vector {index}")
            expected = reference(a, b, op)
            actual = {"result": int(row[1], 16) if re.fullmatch(r"[0-9a-fA-F]{2}", row[1]) else row[1],
                      **{key: int(bit) if bit in "01" else bit for key, bit in zip(("carry", "zero", "overflow"), row[2])}}
            match = actual == expected
            total += 1
            passed += int(match)
            per_op[op]["total"] += 1
            per_op[op]["passed"] += int(match)
            if not match and len(failures) < 16:
                failures.append({"index": index, "A": a, "B": b, "opcode": op,
                                 "expected": expected, "observed": actual})
        if stream.read(1):
            raise ValueError("extra observations")
    return {"format": "chipsim-alu-checks", "version": 1, "stage": stage,
            "checks_passed": passed, "checks_total": total, "correct": passed == total,
            "seed": SEED, "vectors_sha256": fingerprint(vector_bytes(stage)),
            "per_operation": per_op, "failures": failures}


if __name__ == "__main__":
    stage, source, destination = sys.argv[1:]
    result = score(stage, source)
    Path(destination).parent.mkdir(parents=True, exist_ok=True)
    Path(destination).write_text(json.dumps(result, indent=2) + "\n")
