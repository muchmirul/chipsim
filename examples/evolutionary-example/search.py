#!/usr/bin/env python3
"""Run the optional optimizer separately; its signal handlers cannot own the supervisor."""
import os
from pathlib import Path
import sys

from evaluator import HERE, read_json


def main():
    # Optional imports only in this explicitly requested external search process.
    from openevolve import run_evolution
    from openevolve.config import load_config

    adapter_file, config_file, candidate, iterations = sys.argv[1:]
    adapter = read_json(adapter_file, 16384)
    directory = Path(adapter["project"]) / "evaluations" / adapter["session"]
    config = load_config(config_file)
    config.language = "verilog"
    config.file_suffix = ".sv"
    config.enforce_evolve_blocks = True
    config.max_code_length = 65536
    config.evaluator.cascade_evaluation = False
    config.evaluator.use_llm_feedback = False
    config.evaluator.parallel_evaluations = 1
    config.evaluator.max_retries = 0
    config.evaluator.timeout = int(adapter["timeout"]) + 60
    os.environ["CHIPSIM_EVOLUTION_CONFIG"] = adapter_file
    result = run_evolution(initial_program=candidate, evaluator=str(HERE / "evaluator.py"),
                           config=config, iterations=int(iterations),
                           output_dir=str(directory / "openevolve"), cleanup=False)
    if result.best_program is None:
        raise RuntimeError("OpenEvolve returned no best candidate")
    (directory / "selected.sv").write_text(result.best_code)


if __name__ == "__main__":
    main()
