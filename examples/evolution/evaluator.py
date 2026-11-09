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
from benchmarks import benchmark
from definitions import freeze
from feedback import render_report

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
        self.session_directory = self.project / "evaluations" / self.session if self.session else None
        self.directory = None
        if self.session_directory:
            invocation = config.setdefault("invocation", str(uuid.uuid4()))
            if str(uuid.UUID(invocation)) != invocation:
                raise ValueError("invocation must be a canonical UUID")
            self.directory = self.session_directory / "invocations" / invocation
        if self.directory:
            self.directory.mkdir(parents=True, exist_ok=True)
        self.cancel_file = self.directory / "CANCEL" if self.directory else None
        self.active = None

    def evaluate(self, program_path, **lineage):
        definition = freeze(self.config, self.session_directory)
        if definition.get("engine", "design") == "design":
            from custom import evaluate_custom
            return evaluate_custom(self, program_path, **lineage)
        from benchmarks import BENCHMARKS
        return BENCHMARKS[definition["engine"]].evaluate(self, program_path, **lineage)

    def run_stage(self, directory, target, deadline):
        """One managed stage; the caller must gate later stages on readiness."""
        if self.cancel_file.exists():
            raise KeyboardInterrupt("evaluation invocation cancelled")
        if time.monotonic() >= deadline:
            raise TimeoutError("Evaluation deadline before " + target)
        job = self.cli("design", "run", "--project", directory, "--target", target, "--no-reuse")["job"]
        self.last_job = job
        self.active = (directory, job["id"])
        try:
            while job["state"] not in TERMINAL:
                if self.cancel_file.exists():
                    raise KeyboardInterrupt("evaluation invocation cancelled")
                if time.monotonic() >= deadline:
                    raise TimeoutError("Evaluation deadline; cancellation requested for " + target)
                job = self.cli("job", "status", job["id"], "--project", directory,
                               "--wait", "--timeout-ms", "250")["job"]
                self.last_job = job
            artifacts = self.collect_artifacts(directory, job)
            if time.monotonic() >= deadline:
                raise TimeoutError("Evaluation deadline while verifying " + target)
            return job, artifacts
        except BaseException:
            self.cli("job", "cancel", job["id"], "--project", directory)
            self.last_job = self.cli("job", "status", job["id"], "--project", directory,
                                    "--wait", "--timeout-ms", "5000")["job"]
            raise
        finally:
            self.active = None

    def collect_artifacts(self, directory, job):
        """Resolve exact run/attempt producers across paginated artifact listings."""
        if not job.get("run"):
            return {}
        self.cli("artifact", "verify", job["run"], "--project", directory)
        run = self.cli("artifact", "inspect", job["run"], "--project", directory)["record"]
        allowed = {}
        for attempt_id in run["attempts"]:
            attempt = self.cli("artifact", "inspect", attempt_id, "--project", directory)["record"]
            if attempt["job"] != job["id"]:
                raise ValueError("attempt belongs to a different job")
            for artifact_id in attempt["artifacts"]:
                if artifact_id not in run["artifacts"]:
                    raise ValueError("artifact belongs to a different producer")
                allowed[artifact_id] = attempt["task"]
        artifacts, found, offset = {}, set(), 0
        while len(found) < len(allowed):
            page = self.cli("artifact", "list", "--project", directory,
                            "--limit", "200", "--offset", str(offset))
            for record in page["artifacts"]:
                artifact_id = record["id"]
                if artifact_id not in allowed:
                    continue
                task = allowed[artifact_id]
                if record["producer"]["job"] != job["id"] or record["producer"]["task"] != task:
                    raise ValueError("artifact belongs to a different producer")
                artifacts[task + ":" + record["path"]] = artifact_id
                found.add(artifact_id)
            offset = page.get("nextOffset")
            if offset is None:
                break
        if found != set(allowed):
            raise ValueError("missing exact-run artifacts")
        return artifacts

    def report(self, directory, artifact_id, limit=65536):
        inspected = self.cli("artifact", "inspect", artifact_id, "--project", directory)
        return read_json(inspected["payloadPath"], limit)

    def seal_report(self, directory, result, deadline):
        write_json(directory / "evaluation-report.json", result)
        job, artifacts = self.run_stage(directory, "publish", deadline)
        if not job.get("ready") or "publish:out/evaluation.json" not in artifacts:
            raise ValueError("evaluation report publication failed")
        result["report_artifact"] = artifacts["publish:out/evaluation.json"]
        result["report_evidence"] = {"project": str(directory), "job": job["id"], "run": job["run"], "artifact": result["report_artifact"]}
        if "publish:out/inputs.json" in artifacts:
            result["input_evidence"] = {**result["report_evidence"], "artifact": artifacts["publish:out/inputs.json"]}
        self.event("tool", "Sealed evaluation report (agent-reported; follow stage evidence)",
                   stage="report", evidence=result["report_evidence"], candidate=result["candidate"])

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
            if directory.is_symlink() or not directory.is_dir() or not (directory / "chipsim.design.json").is_file():
                continue
            for job in self.cli("job", "status", "--project", directory).get("jobs", []):
                if job["state"] not in TERMINAL:
                    self.cli("job", "cancel", job["id"], "--project", directory)

    def copy_project(self, program, directory):
        directory.mkdir()
        (directory / "counter.sv").write_bytes(program)
        for name in ("counter_tb.sv", "score.py"):
            (directory / name).write_bytes((Path(self.config.get("asset_root", HERE)) / "trusted" / name).read_bytes())
        (directory / "report.py").write_bytes((HERE / "report.py").read_bytes())
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
                "publish": {"adapter": "command", "inputs": ["report.py", "evaluation-report.json"],
                    "options": {"command": sys.executable, "versionArgs": ["--version"],
                                "args": ["report.py", "evaluation-report.json", "out/evaluation.json"]},
                    "outputs": [{"path": "out/evaluation.json", "kind": "report"}]},
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
            "targets": {"publish": {"tasks": ["publish"], "requiredChecks": ["publish:execution", "publish:outputs"]},
                "evaluation": {"tasks": ["score"], "requiredChecks": [
                "simulate:simulation", "simulate:outputs", "score:execution",
                "score:outputs", "score:correctness"]}}})

    def evaluate_counter(self, program_path, *, parent=None, generation=None):
        if self.cancel_file.exists():
            raise KeyboardInterrupt("evaluation invocation cancelled")
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
        from workflow import configure_project, complete
        configure_project(self, directory, program)
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
        failures = []
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
                    artifacts = self.collect_artifacts(directory, job)
                    # Only the exact score task's sealed output supplies metrics.
                    report = artifacts.get("score:out/metrics.json")
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
                        failures = result.get("failures", [])
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
            result = {"format": "chipsim-evolution-evaluation", "version": 1, "benchmark_version": 1,
                      "candidate": candidate, "status": status, "metrics": metrics, "benchmark": "counter",
                      "evidence": evidence, "artifacts": artifacts, "message": detail,
                      "failures": failures,
                      "stages": {"evaluation": {**evidence, "artifacts": artifacts, "ready": job.get("ready", False) if job else False, "state": job["state"] if job else "not-started"}},
                      "fingerprints": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                       for p in directory.iterdir() if p.is_file()}, "reporting": "agent-reported"}
            complete(self, directory, result, started + self.config["timeout"], fields)
        return result


def evaluate(program_path):
    """OpenEvolve's evaluator protocol. Importing this file needs only Python."""
    config = read_json(os.environ["CHIPSIM_EVOLUTION_CONFIG"])
    result = Bridge(config).evaluate(program_path)
    from openevolve.evaluation_result import EvaluationResult
    return EvaluationResult(metrics=result["metrics"], artifacts={
        "feedback": render_report(result, 8192),
        "chipsim_evidence": json.dumps(result["evidence"]),
        "chipsim_report": json.dumps(result.get("report_evidence", {})),
        "candidate_id": result["candidate"],
        "scope": "Agent-reported benchmark results; see exact checks and synthesis context"})
