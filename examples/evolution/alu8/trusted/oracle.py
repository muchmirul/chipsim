"""Independent integer reference model and deterministic binary stimulus."""
import hashlib
import random

SEED = 1
COUNTS = {"directed": 288, "random": 1000, "exhaustive": 524288, "netlist": 524288}


def vectors(stage):
    if stage == "directed":
        for op in range(8):
            for a in (0, 1, 127, 128, 254, 255):
                for b in (0, 1, 127, 128, 254, 255):
                    yield a, b, op
    elif stage == "random":
        rng = random.Random(SEED)
        for _ in range(1000):
            yield rng.randrange(256), rng.randrange(256), rng.randrange(8)
    elif stage in ("exhaustive", "netlist"):
        for op in range(8):
            for a in range(256):
                for b in range(256):
                    yield a, b, op
    else:
        raise ValueError("unknown test stage")


def reference(a, b, op):
    signed_a = a if a < 128 else a - 256
    signed_b = b if b < 128 else b - 256
    carry = overflow = 0
    if op == 0:
        value = a + b
        carry = int(value > 255)
        overflow = int(not -128 <= signed_a + signed_b <= 127)
    elif op == 1:
        value = a - b
        carry = int(a >= b)
        overflow = int(not -128 <= signed_a - signed_b <= 127)
    else:
        value = (a & b, a | b, a ^ b, 255 - a, a * 2, a // 2)[op - 2]
    value &= 255
    return {"result": value, "carry": carry, "zero": int(value == 0), "overflow": overflow}


def vector_bytes(stage):
    return "".join(f"{(a << 11) | (b << 3) | op:05x}\n" for a, b, op in vectors(stage)).encode()


def fingerprint(data):
    return hashlib.sha256(data).hexdigest()
