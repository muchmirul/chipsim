"""ALU pack: immutable inputs, gated managed stages, independent reports."""
import json
from pathlib import Path
import sys
import time
import uuid

from .trusted.oracle import COUNTS, SEED, fingerprint, vector_bytes

HERE = Path(__file__).resolve().parent


def command(tool, args, inputs=(), bindings=(), outputs=(), checks=()):
    return {"adapter": "command", "inputs": list(inputs), "bindings": list(bindings),
            "timeoutMs": 120000, "options": {"command": tool,
            "versionArgs": ["-V"] if tool in ("iverilog", "yosys") else ["--version"] if tool == sys.executable else ["-V"],
            "args": args}, "outputs": [{"path": path, "kind": kind} for path, kind in outputs],
            "checks": list(checks)}


def binding(task, output, path):
    return {"task": task, "output": output, "path": path}


def prepare(bridge, program, directory):
    directory.mkdir()
    (directory / "alu.sv").write_bytes(program)
    assets = Path(bridge.config.get("asset_root", HERE.parent)) / "alu8"
    for path in (assets / "trusted").glob("*"):
        if path.suffix in (".py", ".sv"):
            (directory / path.name).write_bytes(path.read_bytes())
    (directory / "report.py").write_bytes((HERE.parent / "report.py").read_bytes())
    for stage in ("directed", "random", "exhaustive"):
        (directory / (stage + ".hex")).write_bytes(vector_bytes(stage))
    tasks = {"compile": command("iverilog", ["-g2012", "-s", "alu_tb", "-o", "program.vvp", "alu.sv", "alu_tb.sv"],
               ["alu.sv", "alu_tb.sv"], outputs=[("program.vvp", "binary")])}
    targets = {}
    for stage in COUNTS:
        netlist = stage == "netlist"
        vector_stage = "exhaustive" if netlist else stage
        compile_task = "compile-netlist" if netlist else "compile"
        sim = "simulate-" + stage
        score = "score-" + stage
        outputs = [("observations.txt", "observations")]
        if stage == "directed":
            outputs.append(("trace.vcd", "waveform-vcd"))
        tasks[sim] = command("vvp", ["program.vvp", "+VECTORS=" + vector_stage + ".hex", "+COUNT=" + str(COUNTS[stage])]
                             + (["+WAVE"] if stage == "directed" else []), [vector_stage + ".hex"],
                             [binding(compile_task, "program.vvp", "program.vvp")], outputs)
        tasks[score] = command(sys.executable, ["score.py", stage, "observations.txt", "out/metrics.json"],
                              ["score.py", "oracle.py"], [binding(sim, "observations.txt", "observations.txt")],
                              [("out/metrics.json", "report")], [{"name": "correctness", "path": "out/metrics.json",
                              "field": "correct", "operator": "eq", "value": True,
                              "scope": f"{COUNTS[stage]} fixed binary ALU observations ({stage})"}])
        targets[stage] = {"tasks": [score], "requiredChecks": [
            compile_task + ":execution", sim + ":execution", sim + ":outputs", score + ":execution",
            score + ":outputs", score + ":correctness"]}
    tasks["synth"] = command("yosys", ["-p", "read_verilog -sv alu.sv; hierarchy -check -top alu; synth -top alu -flatten; check -assert; write_json netlist.json; write_verilog -noattr netlist.v"],
                             ["alu.sv"], outputs=[("netlist.json", "netlist-graph"), ("netlist.v", "netlist")])
    tasks["cost"] = command(sys.executable, ["cost.py", "netlist.json", "out/cost.json"], ["cost.py"],
                            [binding("synth", "netlist.json", "netlist.json")], [("out/cost.json", "report")])
    targets["synthesis"] = {"tasks": ["cost"], "requiredChecks": ["synth:execution", "synth:outputs", "cost:execution", "cost:outputs"]}
    # Copy the accepted synthesis artifact as an explicit input for the next run.
    tasks["compile-netlist"] = command("iverilog", ["-g2012", "-s", "alu_tb", "-o", "program.vvp", "netlist.v", "alu_tb.sv"],
                                        ["netlist.v", "alu_tb.sv"], outputs=[("program.vvp", "binary")])
    tasks["replay"] = {"adapter": "hdl", "options": {"project": "replay.project.json", "debug": bridge.config["debug"]},
                       "outputs": [{"path": "out/waveform.json", "kind": "waveform"}]}
    targets["replay"] = {"tasks": ["replay"], "requiredChecks": ["replay:simulation", "replay:outputs"]}
    tasks["publish"] = command(sys.executable, ["report.py", "evaluation-report.json", "out/evaluation.json"],
                               ["report.py", "evaluation-report.json"], outputs=[("out/evaluation.json", "report")])
    targets["publish"] = {"tasks": ["publish"], "requiredChecks": ["publish:execution", "publish:outputs"]}
    write(directory / "chipsim.design.json", {"format": "chipsim-design", "version": 1, "id": "alu8-candidate", "tasks": tasks, "targets": targets})
    write(directory / "chipsim.lock.json", {"format": "chipsim-lock", "version": 1, "dependencies": []})


def write(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def replay_testbench(count, source=None):
    if not 1 <= count <= 288:
        raise ValueError("replay requires 1..288 vectors")
    source = (HERE / "trusted" / "alu_tb.sv").read_text() if source is None else source
    return (source.replace("vectors [0:524287]", f"vectors [0:{count - 1}]")
            .replace("count = 288;", f"count = {count};")
            .replace('if ($test$plusargs("WAVE"))', 'if (1)'))


def validate_checks(stage, report):
    total, passed = report.get("checks_total"), report.get("checks_passed")
    if (report.get("format") != "chipsim-alu-checks" or report.get("version") != 1 or report.get("stage") != stage
            or type(total) is not int or total != COUNTS[stage] or type(passed) is not int or not 0 <= passed <= total
            or type(report.get("correct")) is not bool or report["correct"] != (passed == total)
            or report.get("seed") != SEED or report.get("vectors_sha256") != fingerprint(vector_bytes(stage))):
        raise ValueError("invalid trusted " + stage + " report")
    expected_totals = [0] * 8
    from .trusted.oracle import vectors
    for _, _, op in vectors(stage):
        expected_totals[op] += 1
    operations = report.get("per_operation", [])
    if (len(operations) != 8 or any(type(x.get("passed")) is not int or x.get("total") != n or not 0 <= x["passed"] <= n
                                  for x, n in zip(operations, expected_totals))
            or sum(x["passed"] for x in operations) != passed or len(report.get("failures", [])) != min(16, total - passed)):
        raise ValueError("invalid operation coverage")


def evaluate(bridge, program_path, *, parent=None, generation=None):
    source = Path(program_path)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 65536:
        raise ValueError("candidate must be a regular file of at most 64 KiB")
    program = source.read_bytes()
    if len(program) > 65536:
        raise ValueError("candidate exceeds 64 KiB")
    if bridge.cancel_file.exists():
        raise KeyboardInterrupt("evaluation session cancelled")
    started = time.monotonic()
    deadline = started + bridge.config["timeout"]
    candidate = "rtl-" + fingerprint(program)
    directory = bridge.directory / str(uuid.uuid4())
    prepare(bridge, program, directory)
    from workflow import configure_project, complete
    configure_project(bridge, directory, program)
    fields = {"candidate": candidate}
    if parent is not None:
        fields["parent"] = parent
    if generation is not None:
        fields["generation"] = generation
    bridge.event("candidate", "Copied ALU candidate with fixed tests and synthesis recipe", status="running", stage="prepare", **fields)
    result = {"format": "chipsim-evolution-evaluation", "version": 1, "benchmark": "alu8", "benchmark_version": 1,
              "candidate": candidate, "status": "inconclusive", "metrics": {"combined_score": 0.0},
              "stages": {}, "failures": [], "artifacts": {}, "evidence": {"project": str(directory)},
              "reporting": "agent-reported", "message": "No complete ALU evaluation",
              "fingerprints": {p.name: fingerprint(p.read_bytes()) for p in directory.iterdir() if p.is_file()}}
    interrupted = None

    def stage(name):
        bridge.event("tool", "Running ALU " + name, status="running", stage=name, **fields)
        bridge.last_job = None
        try:
            job, artifacts = bridge.run_stage(directory, name, deadline)
        except BaseException:
            if bridge.last_job:
                job = bridge.last_job
                record = {"project": str(directory), "job": job["id"], "state": job["state"],
                          **({"run": job["run"]} if job.get("run") else {})}
                result["stages"][name] = record
                result["evidence"].update({k: record[k] for k in ("job", "run") if k in record})
            raise
        record = {"project": str(directory), "job": job["id"], "state": job["state"], "ready": job.get("ready", False),
                  **({"run": job["run"]} if job.get("run") else {}), "artifacts": artifacts}
        result["stages"][name] = record
        result["artifacts"].update({name + ":" + k: v for k, v in artifacts.items()})
        result["evidence"].update({k: record[k] for k in ("job", "run") if k in record})
        if job["state"] == "cancelled":
            result["status"] = "cancelled"
        elif job["state"] == "failed":
            result["status"] = "failed"
        return job, artifacts

    try:
        for name in ("directed", "random", "exhaustive", "synthesis", "netlist"):
            job, artifacts = stage(name)
            if name == "directed" and artifacts.get("simulate-directed:trace.vcd"):
                # A native VCD is directly inspectable through the existing viewer.
                result["evidence"]["artifact"] = artifacts["simulate-directed:trace.vcd"]
            key = "cost:out/cost.json" if name == "synthesis" else "score-" + name + ":out/metrics.json"
            if key not in artifacts or job["state"] != "completed":
                result["message"] = name + ": " + job["state"] + "; no complete trusted report"
                for path, artifact in artifacts.items():
                    if path.endswith(":execution.json"):
                        execution = bridge.report(directory, artifact)
                        if execution.get("reason"):
                            result["message"] += "; " + str(execution["reason"])[:500]
                break
            report = bridge.report(directory, artifacts[key])
            result["stages"][name]["report"] = report
            if name == "synthesis":
                cells = report.get("cell_count")
                if (report.get("format") != "chipsim-alu-cost" or report.get("version") != 1
                        or type(cells) is not int or cells < 0):
                    raise ValueError("invalid trusted synthesis report")
                result["metrics"]["cell_count"] = cells
                path = bridge.cli("artifact", "inspect", artifacts["synth:netlist.v"], "--project", directory)["payloadPath"]
                (directory / "netlist.v").write_bytes(Path(path).read_bytes())
            else:
                validate_checks(name, report)
                result["metrics"].update({"checks_passed": report["checks_passed"], "checks_total": report["checks_total"]})
                result["failures"] = report["failures"]
                for op, counts in enumerate(report["per_operation"]):
                    result["metrics"][f"op{op}_passed"] = counts["passed"]
                    result["metrics"][f"op{op}_total"] = counts["total"]
            if not job.get("ready"):
                result["status"] = "failed"
                result["message"] = name + ": required checks failed"
                break
        else:
            result["status"] = "passed"
            result["metrics"]["combined_score"] = 1 / (1 + result["metrics"]["cell_count"])
            result["message"] = "All 524288 binary combinations passed on RTL and netlist; " + str(result["metrics"]["cell_count"]) + " generic cells"

        # Reproduce selected failures (or a short passing sample) through the normal HDL viewer.
        if time.monotonic() < deadline and result["status"] != "cancelled":
            failing = result["failures"]
            if failing:
                data = "".join(f"{(x['A'] << 11) | (x['B'] << 3) | x['opcode']:05x}\n" for x in failing).encode()
            else:
                data = vector_bytes("directed")
            (directory / "vectors.hex").write_bytes(data)
            (directory / "replay_tb.sv").write_text(replay_testbench(len(data.splitlines()), (directory / "alu_tb.sv").read_text()))
            replay_source = "netlist.v" if name == "netlist" and failing else "alu.sv"
            result["replay_source"] = replay_source
            write(directory / "replay.project.json", {"format": "chipsim-hdl-project", "version": 1,
                  "name": "Bounded ALU replay", "language": "verilog", "standard": "2012", "sources": [replay_source, "replay_tb.sv"],
                  "top": "alu_tb", "waveform": "trace.vcd", "timeoutMs": 10000, "assets": ["vectors.hex"]})
            job, artifacts = stage("replay")
            preferred = "replay:out/debug.json" if bridge.config["debug"] else "replay:out/waveform.json"
            if preferred in artifacts:
                result["evidence"]["artifact"] = artifacts[preferred]
            if not job.get("ready"):
                result["status"] = "failed"
                result["metrics"]["combined_score"] = 0.0
                result["message"] += "; bounded replay failed"
    except KeyboardInterrupt as error:
        result["status"], result["message"] = "cancelled", "Interrupted; cancellation requested"
        interrupted = error
    except Exception as error:
        if result["status"] != "failed":
            result["status"] = "inconclusive"
        result["message"] = str(error)[:1500]
        result["metrics"]["combined_score"] = 0.0
    finally:
        if result["status"] != "passed":
            result["metrics"]["combined_score"] = 0.0
        complete(bridge, directory, result, deadline, fields)
    if interrupted:
        raise interrupted
    return result
