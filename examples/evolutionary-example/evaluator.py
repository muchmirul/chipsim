#!/usr/bin/env python3
"""External evaluator adapter. ChipSim owns evidence; OpenEvolve owns search."""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

from support import SearchDeadline, read_json, write_json
from workflow import copy_inputs, measured_metrics

HERE = Path(__file__).resolve().parent
EXAMPLES = {
    "counter": {
        "source": "counter.sv", "testbench": "counter_tb.sv", "top": "counter_tb", "checks": 80,
        "goal": "Repair enable/hold behavior of a 4-bit counter against 80 fixed observations; no PPA objective",
    },
    "saturating-adder": {
        "source": "saturating-adder.sv", "testbench": "saturating_adder_tb.sv", "top": "saturating_adder_tb", "checks": 256,
        "goal": "Implement unsigned 4-bit saturating addition min(a+b,15) across all 256 input pairs; no PPA objective",
    },
    "priority-encoder": {
        "source": "priority-encoder.sv", "testbench": "priority_encoder_tb.sv", "top": "priority_encoder_tb", "checks": 256,
        "goal": "Encode the highest asserted bit of an 8-bit request with valid and empty index zero across all 256 masks; no PPA objective",
    },
}
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
MAX_SOURCE_BYTES = 65536
MAX_REPLY_BYTES = 2 * 1024 * 1024


class Bridge:
    def __init__(self, config):
        self.config = config
        self.workflow = config.get("workflow")
        self.evaluation_deadline = None
        self.example_name = config.get("example", "counter")
        self.example = EXAMPLES[self.example_name]
        self.example_directory = HERE / self.example_name
        self.project = Path(config["project"]).resolve(strict=True)
        self.session = config["session"]
        if self.session and str(uuid.UUID(self.session)) != self.session:
            raise ValueError("session must be a canonical UUID")
        self.directory = self.project / "evaluations" / self.session if self.session else None
        if self.directory and config.get("invocation"):
            invocation = config["invocation"]
            if str(uuid.UUID(invocation)) != invocation:
                raise ValueError("invocation must be a canonical UUID")
            self.directory = self.directory / "invocations" / invocation
        if self.directory:
            self.directory.mkdir(parents=True, exist_ok=True)
        self.cancel_file = self.directory / "CANCEL" if self.directory else None
        self.active = None

    def cli(self, *args, timeout=30, cleanup=False):
        if self.evaluation_deadline is not None and not cleanup:
            timeout = min(timeout, self.evaluation_deadline - time.monotonic())
            if timeout <= 0:
                raise TimeoutError("Evaluation deadline exceeded")
        # No shell; external CLI output is bounded before JSON parsing.
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            process = subprocess.Popen([*self.config["chipsim"], *map(str, args)],
                                       stdout=out, stderr=err)
            try:
                process.wait(timeout=timeout)
            except BaseException:
                process.kill()
                process.wait()
                raise
            if out.tell() > MAX_REPLY_BYTES or err.tell() > MAX_REPLY_BYTES:
                raise RuntimeError("ChipSim CLI reply exceeded adapter limit")
            out.seek(0)
            reply = json.load(out)
        if process.returncode or not reply.get("ok"):
            raise RuntimeError(json.dumps(reply.get("diagnostics", reply))[:1500])
        return reply

    def event(self, kind, message, **fields):
        event = {"kind": kind, "message": message, **fields}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", encoding="utf-8") as f:
            json.dump(event, f, allow_nan=False)
            f.flush()
            self.cli("agent", "work-event", self.project, self.session, "--event", f.name)

    def finish(self, status, message):
        self.event("summary", message, status=status)

    def cancel_project(self, directory):
        for job in self.cli("job", "status", "--project", directory, cleanup=True).get("jobs", []):
            if job["state"] not in TERMINAL:
                self.cli("job", "cancel", job["id"], "--project", directory, cleanup=True)

    def cancel_jobs(self):
        self.cancel_file.touch()
        # Each evaluation is isolated, including OpenEvolve's worker processes.
        for directory in self.directory.iterdir():
            try:
                if str(uuid.UUID(directory.name)) != directory.name:
                    continue
            except ValueError:
                continue
            if directory.is_symlink() or not directory.is_dir() or not (directory / "chipsim.design.json").is_file():
                continue
            self.cancel_project(directory)

    def copy_project(self, program, directory):
        if self.workflow:
            copy_inputs(self.workflow, directory)
            (directory / self.workflow["candidate"]).write_bytes(program)
            return
        directory.mkdir()
        source = self.example["source"]
        testbench = self.example["testbench"]
        (directory / source).write_bytes(program)
        for name in (testbench, "score.py"):
            (directory / name).write_bytes((self.example_directory / "trusted" / name).read_bytes())
        timeout_ms = min(120000, int(self.config["timeout"] * 1000))
        write_json(directory / "sim.project.json", {
            "format": "chipsim-hdl-project", "version": 1,
            "name": "Isolated " + self.example_name + " candidate", "language": "verilog",
            "standard": "2012", "sources": [source, testbench],
            "top": self.example["top"], "waveform": "trace.vcd", "timeoutMs": timeout_ms})
        write_json(directory / "chipsim.lock.json", {
            "format": "chipsim-lock", "version": 1, "dependencies": []})
        write_json(directory / "chipsim.design.json", {
            "format": "chipsim-design", "version": 1, "id": self.example_name + "-candidate",
            "tasks": {
                "simulate": {
                    "adapter": "hdl", "options": {"project": "sim.project.json",
                                                    "debug": self.config["debug"]},
                    "outputs": [{"path": "out/waveform.json", "kind": "waveform"}]},
                "score": {
                    "adapter": "command", "inputs": ["score.py"],
                    "bindings": [{"task": "simulate", "output": "out/waveform.json",
                                  "path": "waveform.json"}],
                    "timeoutMs": 10000,
                    "options": {"command": sys.executable, "versionArgs": ["--version"],
                                "args": ["score.py", "waveform.json", "out/metrics.json"]},
                    "outputs": [{"path": "out/metrics.json", "kind": "report"}],
                    "checks": [{"name": "correctness", "path": "out/metrics.json",
                                "field": "combined_score", "operator": "eq", "value": 1,
                                "scope": f"{self.example['checks']} fixed {self.example_name} observations, not equivalence"}]}},
            "targets": {"evaluation": {"tasks": ["score"], "requiredChecks": [
                "simulate:simulation", "simulate:outputs", "score:execution",
                "score:outputs", "score:correctness"]}}})

    def evaluate(self, program_path, *, parent=None, generation=None, optimizer=False, candidate_id=None):
        if self.cancel_file.exists():
            raise KeyboardInterrupt("evaluation session cancelled")
        source = Path(program_path)
        if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_SOURCE_BYTES:
            raise ValueError("candidate must be a regular file of at most 64 KiB")
        with source.open("rb") as candidate_file:
            program = candidate_file.read(MAX_SOURCE_BYTES + 1)
        if len(program) > MAX_SOURCE_BYTES:
            raise ValueError("candidate exceeds 64 KiB")
        source_sha256 = hashlib.sha256(program).hexdigest()
        attempt_id = str(uuid.uuid4())
        candidate = candidate_id or ("eval-" + attempt_id if optimizer else "rtl-" + source_sha256)
        directory = self.directory / attempt_id
        self.copy_project(program, directory)
        fields = {"candidate": candidate}
        if parent is not None:
            fields["parent"] = parent
        if generation is not None:
            fields["generation"] = generation
        self.event("candidate", "Copied candidate RTL with fixed evaluation inputs",
                   status="running", stage="prepare", **fields)
        evidence = {"project": str(directory)}
        # Failure penalties are not measured objective values.
        metrics = {"combined_score": -1.0 if self.workflow else 0.0}
        units = {"combined_score": "fraction"}
        measured = False
        status, detail, job, artifacts = "inconclusive", "No complete evaluation", None, {}
        started = time.monotonic()
        self.evaluation_deadline = started + self.config["timeout"]
        try:
            job = self.cli("design", "run", "--project", directory,
                           "--target", self.workflow["target"] if self.workflow else "evaluation", "--no-reuse")["job"]
            evidence["job"] = job["id"]
            self.active = (directory, job["id"])
            self.event("tool", "Managed evaluation tasks started",
                       status="running", stage="simulation", evidence=evidence, **fields)
            while job["state"] not in TERMINAL:
                if self.cancel_file.exists() or time.monotonic() - started > self.config["timeout"]:
                    self.cli("job", "cancel", job["id"], "--project", directory, cleanup=True)
                    job = self.cli("job", "status", job["id"], "--project", directory,
                                   "--wait", "--timeout-ms", "5000", cleanup=True)["job"]
                    status = "cancelled" if self.cancel_file.exists() else "inconclusive"
                    detail = "Cancelled by caller" if self.cancel_file.exists() else "Evaluation deadline; cancellation requested"
                    break
                job = self.cli("job", "status", job["id"], "--project", directory,
                               "--wait", "--timeout-ms", "250")["job"]
            else:
                status = "failed" if job["state"] == "failed" else "inconclusive"
                detail = "Managed job " + job["state"]
                if job["state"] == "cancelled":
                    status = "cancelled"
                if job.get("run"):
                    evidence["run"] = job["run"]
                    self.cli("artifact", "verify", job["run"], "--project", directory)
                    run = self.cli("artifact", "inspect", job["run"], "--project", directory)["record"]
                    report_spec = self.workflow["report"] if self.workflow else {"task": "score", "path": "out/metrics.json"}
                    by_task = {}
                    # Follow exact attempt IDs, without truncating an artifact listing.
                    for attempt_id in run["attempts"]:
                        attempt = self.cli("artifact", "inspect", attempt_id,
                                           "--project", directory)["record"]
                        if attempt["job"] != job["id"]:
                            continue
                        paths = by_task.setdefault(attempt["task"], {})
                        for artifact_id in attempt["artifacts"]:
                            if artifact_id not in run["artifacts"]:
                                continue
                            artifact = self.cli("artifact", "inspect", artifact_id,
                                                "--project", directory)["artifact"]
                            if artifact["producer"]["job"] == job["id"] and artifact["producer"]["task"] == attempt["task"]:
                                paths[artifact["path"]] = artifact_id
                    artifacts = {task + ":" + path: artifact
                                 for task, paths in by_task.items() for path, artifact in paths.items()}
                    report = by_task.get(report_spec["task"], {}).get(report_spec["path"])
                    if report and job["state"] == "completed":
                        inspected = self.cli("artifact", "inspect", report, "--project", directory)
                        result = read_json(inspected["payloadPath"], 65536)
                        if self.workflow:
                            metrics, units = measured_metrics(self.workflow, result)
                            status = "passed" if job.get("ready") else "failed"
                            if status != "passed":
                                metrics["combined_score"] = -1.0
                            detail = "Measured objectives from verified producer report; " + ("all required checks passed" if status == "passed" else "required checks block fitness; -1 optimizer penalty")
                        else:
                            passed, total, score = (result.get(key) for key in (
                                "checks_passed", "checks_total", "combined_score"))
                            if (type(passed) is not int or type(total) is not int or total != self.example["checks"]
                                    or not 0 <= passed <= total or type(score) not in (int, float)
                                    or not math.isfinite(score) or score != passed / total):
                                raise ValueError("invalid trusted scoring report")
                            metrics = {"combined_score": score, "checks_passed": passed, "checks_total": total}
                            units.update(checks_passed="count", checks_total="count")
                            status = "passed" if job.get("ready") and metrics["combined_score"] == 1 else "failed"
                            detail = f"{passed}/{total} fixed {self.example_name} waveform checks passed; no PPA or equivalence claim"
                        measured = True
                        evidence["artifact"] = report
                preferred = "out/debug.json" if self.config["debug"] else "out/waveform.json"
                if artifacts.get("simulate:" + preferred):
                    evidence["artifact"] = artifacts["simulate:" + preferred]
        except SearchDeadline:
            status, detail = "inconclusive", "Overall search deadline exceeded; managed-job cancellation requested"
            try:
                self.cancel_project(directory)
            except Exception as error:
                detail += "; cancellation failed: " + str(error)[:300]
            raise
        except KeyboardInterrupt:
            status, detail = "cancelled", "Interrupted; managed job cancellation requested"
            try:
                self.cancel_project(directory)
            except Exception as error:
                detail += "; cancellation failed: " + str(error)[:300]
            raise
        except Exception as error:
            detail = str(error)[:1500]
            status = "inconclusive"
            # The launch may have created a detached job before its CLI reply timed out.
            try:
                self.cancel_project(directory)
            except Exception as cleanup_error:
                detail += "; cancellation failed: " + str(cleanup_error)[:300]
        finally:
            self.active = None
            self.evaluation_deadline = None
            if not measured:
                detail += "; combined_score is an optimizer penalty, not a measurement"
            result = {"candidate": candidate, "source_sha256": source_sha256, "status": status, "metrics": metrics,
                      "metric_units": units, "measured": measured,
                      "evidence": evidence, "artifacts": artifacts, "message": detail,
                      "reporting": "agent-reported"}
            if self.workflow:
                result["evaluation_contract"] = {key: self.workflow[key] for key in ("target", "report", "objectives", "sha256")}
            write_json(directory / "evaluation.json", result)
            references = {"evidence": evidence} if len(evidence) > 1 else {}
            self.event("evaluation", detail, status=status, stage="evaluation", **references,
                       metrics={key: {"value": value, "unit": units[key]}
                                for key, value in metrics.items()}, **fields)
        return result


def evaluate(program_path):
    """OpenEvolve's evaluator protocol. Importing this file needs only Python."""
    config = read_json(os.environ["CHIPSIM_EVOLUTION_CONFIG"], 262144)
    result = Bridge(config).evaluate(program_path, optimizer=True)
    from openevolve.evaluation_result import EvaluationResult
    return EvaluationResult(metrics=result["metrics"], artifacts={
        "feedback": result["message"],
        "chipsim_evidence": json.dumps(result["evidence"]),
        "candidate_id": result["candidate"],
        "source_sha256": result["source_sha256"],
        "scope": "Verified managed evaluation under the declared fixed checks and objective scope"})
