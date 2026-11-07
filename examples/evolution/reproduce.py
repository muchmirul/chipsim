"""Re-run a recorded failure in a new managed project."""
from pathlib import Path
import shutil
import sys
import time
import uuid

from definitions import read_json, write_json
from feedback import cases
from verification import artifact_payload
from workflow import configure_project, run_recorded

HERE = Path(__file__).resolve().parent


def replay_case(bridge, original, index):
    failures = cases(original)
    if index >= len(failures):
        raise ValueError("Saved failure case does not exist")
    case = failures[index]
    definition = bridge.config["definition"]
    if not definition.get("replay"):
        raise ValueError("Benchmark has no case replay target; use full reproduction")
    engine = definition.get("engine", "design")
    program = (Path(bridge.config["asset_root"]) / definition["candidate"]).read_bytes()
    directory = bridge.directory / str(uuid.uuid4())
    if engine == "counter":
        bridge.copy_project(program, directory)
        source = (directory / "counter_tb.sv").read_text()
        (directory / "counter_tb.sv").write_text(source.replace("cycle < 80", f"cycle < {case['cycle'] + 1}"))
    elif engine == "alu8":
        from alu8.benchmark import prepare, replay_testbench
        prepare(bridge, program, directory)
        (directory / "replay_tb.sv").write_text(replay_testbench(1, (directory / "alu_tb.sv").read_text()))
        a, b, op = (case["inputs"][key] for key in ("A", "B", "opcode"))
        (directory / "vectors.hex").write_text(f"{(a << 11) | (b << 3) | op:05x}\n")
        source = "alu.sv"
        if original.get("replay_source") == "netlist.v":
            stage = original["stages"]["synthesis"]
            artifact = stage["artifacts"]["synth:netlist.v"]
            path = artifact_payload(bridge, {**stage, "artifact": artifact})
            (directory / "netlist.v").write_bytes(path.read_bytes())
            source = "netlist.v"
        write_json(directory / "replay.project.json", {"format": "chipsim-hdl-project", "version": 1,
            "name": "One saved ALU failure", "language": "verilog", "standard": "2012", "top": "alu_tb",
            "sources": [source, "replay_tb.sv"], "assets": ["vectors.hex"], "waveform": "trace.vcd", "timeoutMs": 10000})
    else:
        from custom import prepare_custom
        prepare_custom(bridge, program, directory)
    write_json(directory / "replay-case.json", case)
    design = read_json(directory / "chipsim.design.json")
    target = definition["replay"]["target"]
    if engine != "design":
        shutil.copyfile(HERE / "replay_score.py", directory / "replay_score.py")
        sim = "simulate" if engine == "counter" else "replay"
        design["tasks"]["replay-score"] = {"adapter": "command",
            "inputs": ["replay_score.py", "replay-case.json"] + (["oracle.py"] if engine == "alu8" else []),
            "bindings": [{"task": sim, "output": "out/waveform.json", "path": "waveform.json"}],
            "options": {"command": sys.executable, "versionArgs": ["--version"],
                        "args": ["replay_score.py", engine, "waveform.json", "replay-case.json", "out/replay.json"]},
            "outputs": [{"path": "out/replay.json", "kind": "report"}],
            "checks": [{"name": "reproduced", "path": "out/replay.json", "field": "reproduced", "operator": "eq", "value": True}]}
        design["targets"]["reproduce"] = {"tasks": ["replay-score"],
            "requiredChecks": [sim + ":simulation", sim + ":outputs", "replay-score:execution", "replay-score:outputs", "replay-score:reproduced"]}
        target, report_key = "reproduce", "replay-score:out/replay.json"
        write_json(directory / "chipsim.design.json", design)
    else:
        declaration = definition["replay"].get("report")
        if not declaration:
            raise ValueError("Custom replay requires a declared report producer")
        report_key = declaration["task"] + ":" + declaration["path"]
    result = {"format": "chipsim-evolution-replay", "version": 1, "candidate": original["candidate"],
              "reproduced": False, "accepted": False, "stages": {}, "artifacts": {},
              "evidence": {"project": str(directory)}, "original": original["report_evidence"], "case": case,
              "scope": "Failure replay only; not full benchmark acceptance"}
    bridge.event("candidate", "Reproduce saved failure with captured inputs", candidate=original["candidate"], stage="replay", status="running")
    job, artifacts = run_recorded(bridge, directory, target, time.monotonic() + bridge.config["timeout"], result)
    if report_key in artifacts:
        report = bridge.report(directory, artifacts[report_key])
        if report.get("format") != "chipsim-evolution-replay" or report.get("version") != 1 or type(report.get("reproduced")) is not bool:
            raise ValueError("Invalid replay report")
        result["report"] = report
        result["reproduced"] = job.get("ready", False) and report["reproduced"]
        result["evidence"]["artifact"] = artifacts[report_key]
    write_json(directory / "replay.json", result)
    bridge.event("tool", "Saved failure reproduced" if result["reproduced"] else "Saved failure not reproduced", candidate=original["candidate"],
                 stage="replay", status="passed" if result["reproduced"] else "failed", evidence=result["evidence"])
    return result
