#!/usr/bin/env python3
"""Evaluate explicit RTL, or let an externally configured OpenEvolve search."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

from evaluator import Bridge, HERE, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["evaluate", "evolve"])
    parser.add_argument("--project", required=True, type=Path,
                        help="existing directory for live work and isolated evaluations")
    parser.add_argument("--candidate", type=Path, default=HERE / "counter.sv")
    parser.add_argument("--session", help="append evaluations to an existing work session")
    parser.add_argument("--parent", help="known parent candidate ID; never inferred")
    parser.add_argument("--generation", type=int, help="known generation; never inferred")
    parser.add_argument("--config", type=Path, help="external OpenEvolve YAML with your LLM configuration")
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=60,
                        help="evaluation wall time in seconds (1..300)")
    parser.add_argument("--debug", action="store_true", help="require installed Icarus observers")
    parser.add_argument("--chipsim", help="installed chipsim executable; default packaged Node CLI")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 300 or not 1 <= args.iterations <= 100:
        parser.error("timeout must be 1..300; iterations 1..100")
    if args.generation is not None and args.generation < 0:
        parser.error("generation must be nonnegative")
    if args.mode == "evolve" and (not args.config or args.session):
        parser.error("evolve requires --config and creates its own session")
    project = args.project.resolve(strict=True)
    if not project.is_dir():
        parser.error("project must be an existing directory")
    config = {"project": str(project), "session": args.session,
              "chipsim": [args.chipsim] if args.chipsim else [
                  "node", str(HERE.parents[1] / "scripts" / "chipsim.mjs")],
              "timeout": args.timeout, "debug": args.debug}
    bridge = Bridge(config)
    owned = args.session is None
    if owned:
        config["session"] = bridge.cli("agent", "work-start", project, "--goal",
            "Improve incomplete 4-bit counter correctness against 80 fixed observations; no PPA objective",
            "--mode", "evolution")["session"]["id"]
        bridge = Bridge(config)
    config_path = bridge.directory / "adapter.json"
    write_json(config_path, config)
    print(f"Session {bridge.session}; inspect with chipsim --agent {project}", file=sys.stderr)
    bridge.event("plan", "Only candidate RTL may change; trusted fixed harness and waveform scorer remain outside search",
                 stage="evaluation")
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    search = None
    def interrupt(signum, frame):
        raise KeyboardInterrupt("termination requested")
    def stop_search():
        if search is None:
            return
        # OpenEvolve may catch TERM and return a best-so-far result. Ignore that
        # result after cancellation; stop its process group, including workers.
        try:
            os.killpg(search.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            search.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(search.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        search.wait()
    for sig in previous:
        signal.signal(sig, interrupt)
    try:
        if args.mode == "evaluate":
            result = bridge.evaluate(args.candidate, parent=args.parent, generation=args.generation)
            if owned:
                bridge.finish("completed" if result["status"] == "passed" else "failed",
                              "Manual candidate evaluation finished; no search was performed")
            print(json.dumps({"session": bridge.session, **result}, indent=2))
            return 0 if result["status"] == "passed" else 1
        # Keep optimizer-owned signal handlers in a separate process. The
        # supervisor retains SIGINT/SIGTERM ownership through final evaluation.
        search = subprocess.Popen([
            sys.executable, str(HERE / "search.py"), str(config_path),
            str(args.config.resolve(strict=True)), str(args.candidate.resolve(strict=True)),
            str(args.iterations)], stdout=sys.stderr, stderr=sys.stderr,
            start_new_session=True)
        if search.wait() != 0:
            raise RuntimeError("External OpenEvolve process failed; inspect its diagnostics")
        search = None
        selected = bridge.directory / "selected.sv"
        # Re-evaluate the selected code; never accept optimizer-reported metrics as evidence.
        final = bridge.evaluate(selected)
        bridge.event("selection", "OpenEvolve selected this candidate; separately re-evaluated with fixed tests",
                     candidate=final["candidate"], status=final["status"],
                     **({"evidence": final["evidence"]} if len(final["evidence"]) > 1 else {}))
        bridge.finish("completed" if final["status"] == "passed" else "failed",
                      "External OpenEvolve search finished; fixed-test scope only")
        print(json.dumps({"session": bridge.session, "selected": str(selected), **final}, indent=2))
        return 0 if final["status"] == "passed" else 1
    except KeyboardInterrupt:
        bridge.cancel_file.touch()
        stop_search()
        bridge.cancel_jobs()
        if owned:
            bridge.finish("cancelled", "Interrupted; cancellation requested for active managed jobs")
        return 130
    except Exception as error:
        stop_search()
        bridge.cancel_jobs()
        if owned:
            bridge.finish("failed", "External evaluation/search failed: " + str(error)[:1200])
        print(str(error), file=sys.stderr)
        return 1
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
