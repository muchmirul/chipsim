"""Standalone benchmark CLI, including project-defined weighted evaluations."""
import argparse
import json
import sys
from pathlib import Path

examples = Path(__file__).resolve().parents[2] / "examples"
weighted = "--workflow" in sys.argv or any(a.startswith("--workflow=") for a in sys.argv)
if weighted:
    sys.path.insert(0, str(examples / "evolutionary-example"))
    if sys.argv[1] in ("validate", "describe"):
        from workflow import load_workflow
        parser = argparse.ArgumentParser()
        parser.add_argument("mode")
        parser.add_argument("--workflow", required=True)
        args = parser.parse_args()
        definition = load_workflow(args.workflow)
        print(json.dumps({"format":"chipsim-evolution-result", "version":1, "command":args.mode,
                          "ok":True, "result":{"valid":True, "definition":definition}}))
    else:
        from run import main
        raise SystemExit(main(standalone=True))
else:
    sys.path.insert(0, str(examples / "evolution"))
    from command import main
    raise SystemExit(main(standalone=True))
