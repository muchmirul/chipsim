#!/usr/bin/env python3
"""Evaluate RTL or search a declared managed workflow with an external OpenEvolve."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

from evaluator import Bridge, EXAMPLES, HERE, MAX_SOURCE_BYTES
from lineage import Lineage
from support import SearchDeadline, write_json
from workflow import freeze_workflow, load_workflow


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["evaluate", "evolve"])
    parser.add_argument("--project", required=True, type=Path,
                        help="existing directory for work sessions and isolated evaluations")
    goal = parser.add_mutually_exclusive_group()
    goal.add_argument("--example", choices=EXAMPLES,
                      help="fixed teaching goal (default: counter)")
    goal.add_argument("--workflow", type=Path,
                      help="version-1 project-defined managed evaluation/objective JSON")
    parser.add_argument("--candidate", type=Path, help="RTL source; default baseline in example/template")
    parser.add_argument("--session", help="append an independent manual evaluation to an existing work session")
    parser.add_argument("--parent", help="known parent candidate ID; never inferred")
    parser.add_argument("--generation", type=int, help="known generation; never inferred")
    parser.add_argument("--config", type=Path, help="external OpenEvolve YAML with your approved LLM configuration")
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=60,
                        help="evaluation wall time in seconds (1..300)")
    parser.add_argument("--search-timeout", type=float, default=900,
                        help="overall evolution budget, including queue waits/finalist (1..86400 seconds)")
    parser.add_argument("--debug", action="store_true", help="require Icarus observers for built-in examples")
    parser.add_argument("--chipsim", help="installed chipsim executable; default packaged Node CLI")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 300 or not 1 <= args.iterations <= 100 or not 1 <= args.search_timeout <= 86400:
        parser.error("timeout must be 1..300; iterations 1..100; search-timeout 1..86400")
    if args.generation is not None and not 0 <= args.generation <= 2**53 - 1:
        parser.error("generation must be a nonnegative safe integer")
    if args.mode == "evolve" and (not args.config or args.session or args.parent or args.generation is not None):
        parser.error("evolve requires --config, owns its session and imports optimizer lineage")
    if args.workflow and args.debug:
        parser.error("custom workflows declare debug behavior in their own HDL task options")
    if not hasattr(signal, "setitimer"):
        parser.error("evolution supervision requires POSIX timers/process groups")
    # Fail before opening a session or creating invocation state on invalid inputs.
    try:
        project = args.project.resolve(strict=True)
        if not project.is_dir():
            raise ValueError("project must be an existing directory")
        workflow = load_workflow(args.workflow) if args.workflow else None
        example_name = args.example or "counter"
        example = EXAMPLES[example_name]
        candidate = args.candidate or (Path(workflow["template"]) / workflow["candidate"] if workflow else HERE / example_name / example["source"])
        if candidate.is_symlink() or not candidate.is_file() or candidate.stat().st_size > MAX_SOURCE_BYTES:
            raise ValueError("candidate must be a regular file of at most 64 KiB")
        candidate = candidate.resolve(strict=True)
        optimizer_config = args.config.resolve(strict=True) if args.mode == "evolve" else None
    except (OSError, ValueError, KeyError) as error:
        parser.error(str(error))
    config = {"project": str(project), "session": None, "example": example_name,
              "invocation": str(uuid.uuid4()), "language": workflow["language"] if workflow else "verilog",
              "suffix": Path(workflow["candidate"]).suffix if workflow else ".sv",
              "chipsim": [args.chipsim] if args.chipsim else ["node", str(HERE.parents[1] / "scripts" / "chipsim.mjs")],
              "timeout": args.timeout, "debug": args.debug}
    bridge = Bridge(config)
    owned = args.session is None
    if owned:
        config["session"] = bridge.cli("agent", "work-start", project, "--goal",
            workflow["goal"] if workflow else example["goal"], "--mode", "evolution")["session"]["id"]
    else:
        status = bridge.cli("agent", "work-status", project, "--session", args.session)
        if status["session"]["status"] != "running":
            parser.error("manual evaluation requires an existing nonterminal work session")
        config["session"] = args.session
    bridge = Bridge(config)
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM)}
    search = None
    lineage = Lineage(bridge)
    deadline = None

    def interrupt(signum, frame):
        raise KeyboardInterrupt("termination requested")

    def expired(signum, frame):
        raise SearchDeadline("overall search wall-time budget exhausted")

    def stop_search():
        if search is None:
            return
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

    def cleanup():
        signal.setitimer(signal.ITIMER_REAL, 0)
        bridge.evaluation_deadline = None
        bridge.cancel_file.touch()
        for action in (stop_search, bridge.cancel_jobs):
            try:
                action()
            except Exception as error:
                print("Cancellation failed: " + str(error)[:600], file=sys.stderr)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, interrupt)
    signal.signal(signal.SIGALRM, expired)
    try:
        if args.mode == "evolve":
            deadline = time.monotonic() + args.search_timeout
            signal.setitimer(signal.ITIMER_REAL, args.search_timeout)
        if workflow:
            config["workflow"] = freeze_workflow(workflow, bridge.directory)
            bridge = Bridge(config)
            lineage = Lineage(bridge)
        config_path = bridge.directory / "adapter.json"
        write_json(config_path, config, exclusive=True)
        print(f"Session {bridge.session}; invocation {config['invocation']}; inspect with chipsim --agent {project}", file=sys.stderr)
        bridge.event("plan", "Only candidate RTL may change; trusted evaluation inputs are fixed per invocation",
                     stage="evaluation")
        if args.mode == "evaluate":
            result = bridge.evaluate(candidate, parent=args.parent, generation=args.generation)
            if owned:
                bridge.finish("completed" if result["status"] == "passed" else "failed", "Manual candidate evaluation finished; no search was performed")
            print(json.dumps({"session": bridge.session, "invocation": config["invocation"], **result}, indent=2))
            return 0 if result["status"] == "passed" else 1
        search = subprocess.Popen([
            sys.executable, str(HERE / "search.py"), str(config_path), str(optimizer_config),
            str(candidate), str(args.iterations)], stdout=sys.stderr, stderr=sys.stderr, start_new_session=True)
        while search.poll() is None:
            lineage.update()
            try:
                search.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
        if search.returncode != 0:
            raise RuntimeError("External OpenEvolve process failed; inspect its diagnostics")
        search = None
        lineage.update()
        selected = bridge.directory / ("selected" + config["suffix"])
        selected_id = lineage.selected(selected)
        # This is a new measurement attempt of the selected individual, not a genetic generation.
        final = bridge.evaluate(selected, candidate_id=selected_id)
        if time.monotonic() >= deadline:
            raise SearchDeadline("overall search wall-time budget exhausted")
        # Finalist measurement completed within budget; commit its journal outcome
        # without an alarm racing the terminal summary.
        signal.setitimer(signal.ITIMER_REAL, 0)
        bridge.event("selection", "Optimizer selection separately re-evaluated against fixed inputs/checks",
                     candidate=final["candidate"], status=final["status"],
                     **({"evidence": final["evidence"]} if len(final["evidence"]) > 1 else {}))
        bridge.finish("completed" if final["status"] == "passed" else "failed", "External search finished under declared evaluation scope")
        print(json.dumps({"session": bridge.session, "invocation": config["invocation"], "selected": str(selected), **final}, indent=2))
        return 0 if final["status"] == "passed" else 1
    except SearchDeadline:
        cleanup()
        if owned:
            bridge.finish("failed", "Overall search wall-time budget exhausted; active work cancellation requested; no selection accepted")
        print("Overall search wall-time budget exhausted", file=sys.stderr)
        return 124
    except KeyboardInterrupt:
        cleanup()
        if owned:
            bridge.finish("cancelled", "Interrupted; cancellation requested for this invocation's managed jobs")
        return 130
    except Exception as error:
        cleanup()
        if owned:
            bridge.finish("failed", "External evaluation/search failed: " + str(error)[:1200])
        print(str(error), file=sys.stderr)
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
