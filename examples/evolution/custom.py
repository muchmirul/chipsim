"""Evaluate user-defined projects through existing ChipSim design targets."""
import math
from pathlib import Path
import time
import uuid

from definitions import digest, pack, unpack
from workflow import configure_project, complete, run_recorded


def validate_stage(report, stage):
    if report.get("format") != "chipsim-evolution-stage" or report.get("version") != 1:
        raise ValueError("Expected chipsim-evolution-stage version 1")
    metrics = report.get("metrics")
    if not isinstance(metrics, dict) or len(metrics) > 32:
        raise ValueError("Stage report needs at most 32 numeric metrics")
    for name, value in metrics.items():
        if not isinstance(name, str) or not 1 <= len(name) <= 64 or type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError("Stage metrics must be finite numbers")
    if metrics.get("combined_score", 0) < 0:
        raise ValueError("combined_score must be nonnegative")
    total, passed = metrics.get("checks_total"), metrics.get("checks_passed")
    if total is not None or passed is not None or "expected_checks" in stage:
        if (type(total) is not int or type(passed) is not int or total < 1 or not 0 <= passed <= total
                or ("expected_checks" in stage and total != stage["expected_checks"])):
            raise ValueError("Missing or incomplete trusted check counts")
    cases = report.get("cases", [])
    if not isinstance(cases, list) or len(cases) > 16:
        raise ValueError("Expected at most 16 failure cases")
    if total is not None and len(cases) > total - passed:
        raise ValueError("Failure cases contradict check counts")
    for case in cases:
        if not isinstance(case, dict) or not all(k in case for k in ("check", "inputs", "expected", "observed")):
            raise ValueError("Failure case needs check, inputs, expected and observed")
    return metrics, cases


def prepare_custom(bridge, program, directory):
    definition = bridge.config["definition"]
    bundle = pack(definition, Path(bridge.config["asset_root"]), program)
    unpack(bundle, directory)
    configure_project(bridge, directory, program)


def evaluate_custom(bridge, program_path, *, parent=None, generation=None):
    source = Path(program_path)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 65536:
        raise ValueError("Candidate must be a regular file of at most 64 KiB")
    program = source.read_bytes()
    if len(program) > 65536:
        raise ValueError("Candidate exceeds 64 KiB")
    deadline = time.monotonic() + bridge.config["timeout"]
    directory = bridge.directory / str(uuid.uuid4())
    prepare_custom(bridge, program, directory)
    definition = bridge.config["definition"]
    result = {"format": "chipsim-evolution-evaluation", "version": 2, "benchmark": definition["id"],
              "benchmark_version": 1, "candidate": "rtl-" + digest(program), "status": "inconclusive",
              "message": "Evaluation not completed", "metrics": {"combined_score": 0.0}, "stages": {},
              "cases": [], "artifacts": {}, "evidence": {"project": str(directory)}, "reporting": "agent-reported"}
    fields = {"candidate": result["candidate"]}
    if parent is not None:
        fields["parent"] = parent
    if generation is not None:
        fields["generation"] = generation
    bridge.event("candidate", "Copied candidate with frozen benchmark inputs", status="running", stage="prepare", **fields)
    interrupted = None
    scored = False
    try:
        for stage in definition["stages"]:
            target = stage["target"]
            bridge.event("tool", "Running " + target, status="running", stage=target, **fields)
            job, artifacts = run_recorded(bridge, directory, target, deadline, result)
            declaration = stage.get("report")
            if declaration and job["state"] == "completed":
                key = declaration["task"] + ":" + declaration["path"]
                if key not in artifacts:
                    raise ValueError("Missing trusted report from the current run: " + key)
                report = bridge.report(directory, artifacts[key])
                metrics, cases = validate_stage(report, stage)
                result["metrics"].update(metrics)
                scored = scored or "combined_score" in metrics
                result["cases"] = [{**case, "id": i, "stage": target} for i, case in enumerate(cases)]
                result["stages"][target]["report"] = report
                if metrics.get("checks_passed") != metrics.get("checks_total"):
                    result["status"] = "failed"
                    result["message"] = target + ": behavioral checks failed"
                    break
            if not job.get("ready"):
                result["status"] = "cancelled" if job["state"] == "cancelled" else "failed" if job["state"] == "failed" else "inconclusive"
                result["message"] = target + ": required checks did not pass"
                break
        else:
            if not scored or definition["objective"]["metric"] not in result["metrics"]:
                raise ValueError("Complete evaluation requires combined_score and the declared objective")
            result["status"], result["message"] = "passed", "All required benchmark checks passed"
    except KeyboardInterrupt as error:
        interrupted = error
        result["status"], result["message"] = "cancelled", "Interrupted; managed job cancellation requested"
    except Exception as error:
        result["status"], result["message"] = "inconclusive", str(error)[:1500]
        result["diagnostics"] = [{"category": "timeout" if isinstance(error, TimeoutError) else "invalid_evidence", "message": result["message"]}]
    finally:
        if result["status"] != "passed":
            result["metrics"]["combined_score"] = 0.0
        complete(bridge, directory, result, deadline, fields)
    if interrupted:
        raise interrupted
    return result
