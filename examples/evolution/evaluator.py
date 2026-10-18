#!/usr/bin/env python3
"""External evaluator adapter. ChipSim owns evidence; OpenEvolve owns search."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
MAX_SOURCE_BYTES = 65536
MAX_REPLY_BYTES = 2 * 1024 * 1024


def read_json(path, limit=MAX_REPLY_BYTES):
    path = Path(path)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > limit:
        raise ValueError("expected bounded regular JSON file: " + str(path))
    return json.loads(path.read_text())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


class Bridge:
    def __init__(self, config):
        self.config = config
        self.project = Path(config["project"]).resolve(strict=True)
        self.session = config["session"]
        if self.session and str(uuid.UUID(self.session)) != self.session:
            raise ValueError("session must be a canonical UUID")
        self.directory = self.project / "evaluations" / self.session if self.session else None
        if self.directory:
            self.directory.mkdir(parents=True, exist_ok=True)
        self.cancel_file = self.directory / "CANCEL" if self.directory else None
        self.active = None

    def cli(self, *args, timeout=30):
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

    def cancel_jobs(self):
        self.cancel_file.touch()
        # Each evaluation is isolated, including OpenEvolve's worker processes.
        for directory in self.directory.iterdir():
            if not directory.is_dir() or not (directory / "chipsim.design.json").is_file():
                continue
            for job in self.cli("job", "status", "--project", directory).get("jobs", []):
                if job["state"] not in TERMINAL:
                    self.cli("job", "cancel", job["id"], "--project", directory)

    def copy_project(self, program, directory):
        directory.mkdir()
        (directory / "counter.sv").write_bytes(program)
        for name in ("counter_tb.sv", "score.py"):
            (directory / name).write_bytes((HERE / "trusted" / name).read_bytes())
        timeout_ms = min(120000, int(self.config["timeout"] * 1000))
        write_json(directory / "sim.project.json", {
            "format": "chipsim-hdl-project", "version": 1,
            "name": "Isolated counter candidate", "language": "verilog",
            "standard": "2012", "sources": ["counter.sv", "counter_tb.sv"],
            "top": "counter_tb", "waveform": "trace.vcd", "timeoutMs": timeout_ms})
        write_json(directory / "chipsim.lock.json", {
            "format": "chipsim-lock", "version": 1, "dependencies": []})
        write_json(directory / "chipsim.design.json", {
            "format": "chipsim-design", "version": 1, "id": "counter-candidate",
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
                                "scope": "80 fixed sampled counter observations, not equivalence"}]}},
            "targets": {"evaluation": {"tasks": ["score"], "requiredChecks": [
                "simulate:simulation", "simulate:outputs", "score:execution",
                "score:outputs", "score:correctness"]}}})

    def evaluate(self, program_path, *, parent=None, generation=None):
        if self.cancel_file.exists():
            raise KeyboardInterrupt("evaluation session cancelled")
        source = Path(program_path)
        if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_SOURCE_BYTES:
            raise ValueError("candidate must be a regular file of at most 64 KiB")
        with source.open("rb") as candidate_file:
            program = candidate_file.read(MAX_SOURCE_BYTES + 1)
        if len(program) > MAX_SOURCE_BYTES:
            raise ValueError("candidate exceeds 64 KiB")
        candidate = "rtl-" + hashlib.sha256(program).hexdigest()
        directory = self.directory / str(uuid.uuid4())
        self.copy_project(program, directory)
        fields = {"candidate": candidate}
        if parent is not None:
            fields["parent"] = parent
        if generation is not None:
            fields["generation"] = generation
        self.event("candidate", "Copied candidate RTL with fixed harness and scorer",
                   status="running", stage="prepare", **fields)
        evidence = {"project": str(directory)}
        # Zero is an optimizer penalty until a complete trusted report exists.
        metrics = {"combined_score": 0.0}
        status, detail, job, artifacts = "inconclusive", "No complete evaluation", None, {}
        started = time.monotonic()
        try:
            job = self.cli("design", "run", "--project", directory,
                           "--target", "evaluation", "--no-reuse")["job"]
            evidence["job"] = job["id"]
            self.active = (directory, job["id"])
            self.event("tool", "Managed simulation and independent waveform scoring started",
                       status="running", stage="simulation", evidence=evidence, **fields)
            while job["state"] not in TERMINAL:
                if self.cancel_file.exists() or time.monotonic() - started > self.config["timeout"]:
                    self.cli("job", "cancel", job["id"], "--project", directory)
                    job = self.cli("job", "status", job["id"], "--project", directory,
                                   "--wait", "--timeout-ms", "5000")["job"]
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
                    allowed = {}
                    for attempt_id in run["attempts"]:
                        attempt = self.cli("artifact", "inspect", attempt_id,
                                           "--project", directory)["record"]
                        if attempt["job"] == job["id"] and attempt["task"] in ("simulate", "score"):
                            allowed[attempt["task"]] = set(attempt["artifacts"])
                    records = self.cli("artifact", "list", "--project", directory,
                                       "--limit", "200")["artifacts"]
                    # The RTL can write colliding filenames. Only the score task's
                    # sealed report may supply metrics, never a simulation artifact.
                    by_task = {task: {a["path"]: a["id"] for a in records
                                     if a["id"] in ids and a["id"] in run["artifacts"]
                                     and a["producer"]["job"] == job["id"]
                                     and a["producer"]["task"] == task}
                               for task, ids in allowed.items()}
                    artifacts = {task + ":" + path: artifact
                                 for task, paths in by_task.items() for path, artifact in paths.items()}
                    report = by_task.get("score", {}).get("out/metrics.json")
                    if report and job["state"] == "completed":
                        inspected = self.cli("artifact", "inspect", report, "--project", directory)
                        result = read_json(inspected["payloadPath"], 65536)
                        passed, total, score = (result.get(key) for key in (
                            "checks_passed", "checks_total", "combined_score"))
                        if (type(passed) is not int or type(total) is not int or total != 80
                                or not 0 <= passed <= total or type(score) not in (int, float)
                                or score != passed / total):
                            raise ValueError("invalid trusted scoring report")
                        metrics = {"combined_score": score, "checks_passed": passed, "checks_total": total}
                        status = "passed" if job.get("ready") and metrics["combined_score"] == 1 else "failed"
                        detail = f"{metrics['checks_passed']}/80 fixed waveform checks passed; no PPA or equivalence claim"
                preferred = "out/debug.json" if self.config["debug"] else "out/waveform.json"
                if artifacts.get("simulate:" + preferred):
                    evidence["artifact"] = artifacts["simulate:" + preferred]
        except KeyboardInterrupt:
            if job:
                self.cli("job", "cancel", job["id"], "--project", directory)
            status, detail = "cancelled", "Interrupted; managed job cancellation requested"
            raise
        except Exception as error:
            if job and job["state"] not in TERMINAL:
                self.cli("job", "cancel", job["id"], "--project", directory)
            detail = str(error)[:1500]
        finally:
            self.active = None
            if "checks_passed" not in metrics:
                detail += "; score zero is an optimizer penalty, not a measured check count"
            result = {"candidate": candidate, "status": status, "metrics": metrics,
                      "evidence": evidence, "artifacts": artifacts, "message": detail,
                      "reporting": "agent-reported"}
            write_json(directory / "evaluation.json", result)
            references = {"evidence": evidence} if len(evidence) > 1 else {}
            self.event("evaluation", detail, status=status, stage="evaluation", **references,
                       metrics={key: {"value": value, "unit": "fraction" if key == "combined_score" else "count"}
                                for key, value in metrics.items()}, **fields)
        return result


def evaluate(program_path):
    """OpenEvolve's evaluator protocol. Importing this file needs only Python."""
    config = read_json(os.environ["CHIPSIM_EVOLUTION_CONFIG"], 16384)
    result = Bridge(config).evaluate(program_path)
    from openevolve.evaluation_result import EvaluationResult
    return EvaluationResult(metrics=result["metrics"], artifacts={
        "feedback": result["message"],
        "chipsim_evidence": json.dumps(result["evidence"]),
        "candidate_id": result["candidate"],
        "scope": "Agent-reported fixed-test correctness, not formal equivalence or PPA"})
