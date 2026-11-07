"""Explicit local benchmark registry; no provider or plugin loading on import."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


class Counter:
    id = "counter"
    version = 1
    initial = HERE / "counter.sv"
    timeout = 60
    goal = "Improve incomplete 4-bit counter correctness against 80 fixed observations; no PPA objective"

    @staticmethod
    def evaluate(bridge, program, **lineage):
        return bridge.evaluate_counter(program, **lineage)


class Alu8:
    id = "alu8"
    version = 1
    initial = HERE / "alu8" / "alu.sv"
    timeout = 300
    goal = "Reduce generic synthesized ALU cell count while preserving all 524288 binary input combinations"

    @staticmethod
    def evaluate(bridge, program, **lineage):
        from alu8.benchmark import evaluate
        return evaluate(bridge, program, **lineage)


BENCHMARKS = {b.id: b for b in (Counter, Alu8)}


def benchmark(config):
    return BENCHMARKS[config.get("benchmark", "counter")]
