#!/usr/bin/env python3
"""Run the optional optimizer separately; its signal handlers cannot own the supervisor."""
import os
from pathlib import Path
import sys

from evaluator import HERE
from support import read_json, write_json


def main():
    # Optional imports only in this explicitly requested external search process.
    from openevolve import run_evolution
    from openevolve.config import load_config

    adapter_file, config_file, candidate, iterations = sys.argv[1:]
    adapter = read_json(adapter_file, 262144)
    directory = Path(adapter_file).parent
    config = load_config(config_file)
    config.language = adapter.get("language", "verilog")
    config.file_suffix = adapter.get("suffix", ".sv")
    config.checkpoint_interval = 1
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
    (directory / ("selected" + config.file_suffix)).write_text(result.best_code, encoding="utf-8")
    write_json(directory / "selected.json", {"id": result.best_program.id}, exclusive=True)


if __name__ == "__main__":
    main()
