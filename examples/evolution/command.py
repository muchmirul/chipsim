"""Public text/JSON evolution commands; importing never starts tools or search."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

from definitions import BUILTINS, freeze, identity, load_definition, unpack, write_json
from evaluator import Bridge, HERE
from feedback import read_report, render_report, compare, render_comparison, clean
from verification import verify_report, reproduction_inputs


def parser():
    p = argparse.ArgumentParser(description="Text-based hardware evaluation and external evolution")
    p.add_argument("mode", choices=["list", "describe", "validate", "evaluate", "evolve", "report", "compare", "reproduce"])
    p.add_argument("reports", nargs="*")
    p.add_argument("--project", type=Path, help="existing work directory")
    p.add_argument("--benchmark", default="counter", help="counter,alu8 or a benchmark JSON file")
    p.add_argument("--candidate", type=Path)
    p.add_argument("--config", type=Path, help="your external OpenEvolve YAML")
    p.add_argument("--session")
    p.add_argument("--parent")
    p.add_argument("--generation", type=int)
    p.add_argument("--iterations", type=int, default=5)
    p.add_argument("--timeout", type=float)
    p.add_argument("--debug", action="store_true")
    p.add_argument("--formal", action="store_true", help="require the declared formal equivalence check")
    p.add_argument("--case", type=int, help="saved failure case index for reproduction")
    p.add_argument("--chipsim")
    p.add_argument("--format", choices=["json", "text"], default="json")
    return p


def output(value, args, ok=True, legacy=False):
    if args.format == "text":
        if value.get("format") == "chipsim-evolution-evaluation":
            text = render_report(value)
        elif args.mode == "compare" and "comparable" in value:
            text = render_comparison(value)
        else:
            text = clean(json.dumps(value, indent=2)) + "\n"
        print(text, end="")
    else:
        print(json.dumps(value if legacy else {"format": "chipsim-evolution-result", "version": 1,
              "command": args.mode, "ok": ok, "result": value}, indent=2, allow_nan=False))


def main(argv=None, legacy=False):
    p = parser()
    args = p.parse_args(argv)
    bridge = None
    owned = False
    search = None
    previous = {}
    def stop_search():
        nonlocal search
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
        search = None
    try:
        if not 1 <= args.iterations <= 100 or (args.timeout is not None and not 1 <= args.timeout <= 300):
            raise ValueError("timeout must be 1..300; iterations 1..100")
        if args.generation is not None and args.generation < 0:
            raise ValueError("generation must be nonnegative")
        if args.case is not None and (args.case < 0 or args.mode != "reproduce"):
            raise ValueError("--case requires reproduce and a nonnegative index")
        cli = [args.chipsim] if args.chipsim else ["node", str(HERE.parents[1] / "scripts/chipsim.mjs")]
        if args.mode == "list":
            output({"benchmarks": [load_definition(n)[0] for n in BUILTINS]}, args, legacy=legacy)
            return 0
        if args.mode in ("describe", "validate"):
            definition, _ = load_definition(args.benchmark)
            output({"valid": True, "definition": definition}, args, legacy=legacy)
            return 0
        if args.mode in ("report", "compare", "reproduce"):
            if len(args.reports) != (2 if args.mode == "compare" else 1):
                raise ValueError("Expected " + ("two reports" if args.mode == "compare" else "one report"))
            reports = [read_report(path) for path in args.reports]
            reader = Bridge({"project": str(Path.cwd()), "session": None, "chipsim": cli})
            if args.mode != "reproduce":
                for report in reports:
                    try:
                        verify_report(reader, report)
                        report["verified"] = True
                    except Exception as error:
                        report["verified"], report["verification_error"] = False, str(error)
                value = compare(*reports) if args.mode == "compare" else reports[0]
                output(value, args, legacy=legacy)
                return 0
            bundle = reproduction_inputs(reader, reports[0])
            definition = bundle["definition"]
        else:
            if args.reports:
                raise ValueError("Unexpected positional arguments")
            definition, root = load_definition(args.benchmark)
        if args.project is None or not args.project.resolve(strict=True).is_dir():
            raise ValueError("--project requires an existing directory")
        if args.mode == "evolve" and (not args.config or args.session):
            raise ValueError("evolve requires --config and creates its own session")
        if args.formal and not definition.get("formal"):
            raise ValueError("Benchmark has no formal recipe")
        config = {"project": str(args.project.resolve()), "session": args.session, "chipsim": cli,
                  "benchmark": str(args.benchmark), "timeout": args.timeout or definition.get("timeout", 60),
                  "debug": args.debug, "formal": args.formal or definition.get("formal", {}).get("required", False)}
        if args.mode == "reproduce":
            if args.session or args.candidate or args.timeout is not None or args.formal or args.debug:
                raise ValueError("Reproduction uses captured settings and creates a new session")
            config.update(bundle["settings"])
            config["reproduction"] = {"report": reports[0]["report_evidence"], "case": args.case}
        bridge = Bridge(config)
        owned = args.session is None
        if owned:
            config["session"] = bridge.cli("agent", "work-start", args.project, "--goal", definition["description"], "--mode", "evolution")["session"]["id"]
            bridge = Bridge(config)
        if args.mode == "reproduce":
            snapshot = bridge.session_directory / "benchmark-inputs"
            snapshot.mkdir()
            write_json(snapshot / "inputs.json", bundle)
            unpack(bundle, snapshot / "files")
            config.update(definition=definition, asset_root=str(snapshot / "files"), inputs_hash=identity(bundle))
        else:
            freeze(config, bridge.session_directory)
        candidate = args.candidate or Path(config["asset_root"]) / definition["candidate"]
        config_path = bridge.directory / "adapter.json"
        write_json(config_path, config)
        print(f"Session {bridge.session}; invocation {config['invocation']}; inspect with chipsim --agent {args.project}", file=sys.stderr)
        def interrupt(signum, frame):
            raise KeyboardInterrupt("termination requested")
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        for sig in previous:
            signal.signal(sig, interrupt)
        bridge.event("plan", "Evaluate one editable RTL file with frozen trusted inputs and linked evidence", stage="evaluation")
        if args.mode == "evolve":
            search = subprocess.Popen([sys.executable, str(HERE / "search.py"), str(config_path),
                str(args.config.resolve(strict=True)), str(candidate.resolve(strict=True)), str(args.iterations)],
                stdout=sys.stderr, stderr=sys.stderr, start_new_session=True)
            if search.wait() != 0:
                raise RuntimeError("External OpenEvolve process failed; inspect diagnostics")
            search = None
            candidate = bridge.directory / "selected.sv"
        if args.mode == "reproduce" and args.case is not None:
            from reproduce import replay_case
            result = replay_case(bridge, reports[0], args.case)
            passed = result["reproduced"]
        else:
            result = bridge.evaluate(candidate, parent=args.parent, generation=args.generation)
            passed = result["status"] == "passed"
        if args.mode == "evolve":
            bridge.event("selection", "Optimizer selection independently re-evaluated with all required checks", candidate=result["candidate"], status=result["status"])
        if owned:
            bridge.finish("completed" if passed else "failed", "Evaluation finished; consult captured checks and scope")
        output({"session": bridge.session, **({"selected": str(candidate)} if args.mode == "evolve" else {}), **result}, args, passed, legacy)
        return 0 if passed else 1
    except KeyboardInterrupt:
        stop_search()
        if bridge and bridge.session:
            try:
                bridge.cancel_jobs()
                if owned:
                    bridge.finish("cancelled", "Interrupted; cancellation requested for managed jobs")
            except Exception as cleanup:
                print("Cancellation cleanup: " + str(cleanup)[:1200], file=sys.stderr)
        output({"status": "cancelled", "message": "Interrupted; cancellation requested"}, args, False, legacy)
        return 130
    except Exception as error:
        stop_search()
        if bridge and bridge.session:
            try:
                bridge.cancel_jobs()
                if owned:
                    bridge.finish("failed", "Evolution command failed: " + str(error)[:1200])
            except Exception as cleanup:
                print("Failure cleanup: " + str(cleanup)[:1200], file=sys.stderr)
        output({"status": "error", "message": str(error)}, args, False, legacy)
        return 1
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
