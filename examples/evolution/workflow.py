"""Common managed stages, evidence context, formal gates and report publication."""
import json
from pathlib import Path
import shutil
import sys
import time

from definitions import digest, identity, pack, read_json, write_json, evaluator_identity, project_info
from feedback import cases

HERE = Path(__file__).resolve().parent


def configure_project(bridge, directory, program):
    definition = bridge.config["definition"]
    bundle = pack(definition, Path(bridge.config["asset_root"]), program)
    bundle["settings"] = {key: bridge.config.get(key, False) for key in ("timeout", "debug", "formal")}
    write_json(directory / "evolution-inputs.json", bundle)
    shutil.copyfile(HERE / "report.py", directory / "evolution-publish.py")
    design = read_json(directory / "chipsim.design.json")
    design["tasks"]["publish"] = {
        "adapter": "command", "inputs": ["evolution-publish.py", "evaluation-report.json", "evolution-inputs.json"],
        "options": {"command": sys.executable, "versionArgs": ["--version"],
                    "args": ["evolution-publish.py", "evaluation-report.json", "out/evaluation.json", "evolution-inputs.json"]},
        "outputs": [{"path": "out/evaluation.json", "kind": "report"}, {"path": "out/inputs.json", "kind": "evolution-inputs"}]}
    design["targets"]["publish"] = {"tasks": ["publish"], "requiredChecks": ["publish:execution", "publish:outputs"]}
    formal = definition.get("formal")
    if formal and definition.get("engine") in ("counter", "alu8"):
        source = "counter.sv" if definition["engine"] == "counter" else "alu.sv"
        top = "counter" if definition["engine"] == "counter" else "alu"
        reference = Path(bridge.config["asset_root"]) / formal["reference"]
        (directory / "gold.sv").write_bytes(reference.read_bytes())
        wrapper = []
        if top == "counter":
            (directory / "formal-wrapper.sv").write_text(
                "module formal_top(input clk, reset, enable, output [3:0] count);\n"
                "reg started = 0; always @(posedge clk) started <= 1;\n"
                "counter dut(.clk(clk), .reset(reset | !started), .enable(enable), .count(count));\nendmodule\n")
            wrapper = ["formal-wrapper.sv"]
            top = "formal_top"
        script = ""
        for role, file in (("gold", "gold.sv"), ("gate", source)):
            script += f"[{role}]\nread_verilog -sv {file} {' '.join(wrapper)}\nprep -top {top} -flatten\n\n"
        script += "[strategy simple]\nuse sat\ndepth 10\n"
        (directory / "equivalence.eqy").write_text(script)
        design["tasks"]["formal"] = {
            "adapter": "eqy", "inputs": [source, "gold.sv", *wrapper], "timeoutMs": 120000,
            "options": {"config": "equivalence.eqy", "scope": formal["scope"], "assumptions": formal["assumptions"]}}
        design["targets"]["formal"] = {"tasks": ["formal"], "requiredChecks": ["formal:execution", "formal:equivalence"]}
    write_json(directory / "chipsim.design.json", design)


def stage_metadata(bridge, directory, record):
    if not record.get("run"):
        return {"checks": [], "tools": [], "runtime": []}
    return project_info("inspect-run", directory, record["run"])


def run_recorded(bridge, directory, target, deadline, result):
    bridge.last_job = None
    try:
        job, artifacts = bridge.run_stage(directory, target, deadline)
    except BaseException:
        job = bridge.last_job
        if job:
            result["stages"][target] = {"project": str(directory), "job": job["id"], "state": job["state"],
                                        **({"run": job["run"]} if job.get("run") else {})}
        raise
    record = {"project": str(directory), "job": job["id"], "state": job["state"],
              "ready": job.get("ready", False), "artifacts": artifacts,
              **({"run": job["run"]} if job.get("run") else {})}
    result["stages"][target] = record
    result["artifacts"].update({target + ":" + k: v for k, v in artifacts.items()})
    result["evidence"].update({k: record[k] for k in ("job", "run") if k in record})
    return job, artifacts


def complete(bridge, directory, result, deadline, fields):
    definition = bridge.config["definition"]
    formal = definition.get("formal", {})
    required = bridge.config.get("formal", False) or formal.get("required", False)
    result["version"] = 2
    result["objective"] = definition["objective"]
    result["cases"] = cases(result)
    result.setdefault("diagnostics", [])
    result["formal"] = {"required": required, "status": "not-run" if required else "disabled",
                        "scope": formal.get("scope", ""), "assumptions": formal.get("assumptions", [])}
    if result["status"] == "cancelled":
        result["accepted"] = False
        result["metrics"]["combined_score"] = 0.0
        result["diagnostics"].append({"category": "cancelled", "message": result["message"]})
        write_json(directory / "evaluation.json", result)
        bridge.event("evaluation", result["message"], status="cancelled", stage="evaluation", **fields)
        return result
    try:
        if required and result["status"] == "passed":
            if not formal:
                raise ValueError("Benchmark has no declared formal recipe")
            job, _ = run_recorded(bridge, directory, formal["target"], deadline, result)
            result["formal"]["status"] = "proven" if job.get("ready") else "not-proven"
            if job.get("ready"):
                result["message"] = result["message"].replace("no PPA or equivalence claim", "no PPA claim") + "; formal equivalence proven within recorded scope"
            if not job.get("ready"):
                result["status"] = "inconclusive"
                result["message"] += "; required formal equivalence not established"
        tools, runtimes = {}, set()
        for name, record in result["stages"].items():
            metadata = stage_metadata(bridge, directory, record)
            record.update(metadata)
            record["outcome"] = "passed" if record.get("ready") else "failed" if any(c["verdict"] == "fail" for c in metadata["checks"]) else "inconclusive"
            for tool in metadata["tools"]:
                # Absolute installation path is not an optimization parameter.
                key = identity({k: v for k, v in tool.items() if k != "path"})
                tools[key] = {k: v for k, v in tool.items() if k != "path"}
            runtimes.update(metadata["runtime"])
            log_excerpt = ""
            if any(not execution.get("ok", False) for execution in metadata.get("executions", [])):
                try:
                    log_excerpt = bridge.cli("job", "logs", record["job"], "--project", directory, "--limit", "4000").get("text", "")
                except Exception:
                    # Failure details are optional enrichment; native checks remain authoritative.
                    pass
            for path, artifact in record.get("artifacts", {}).items():
                if path.endswith(":out/diagnostics.json") and not record.get("ready"):
                    native = bridge.report(directory, artifact, 2 * 1024 * 1024)
                    for diagnostic in native if isinstance(native, list) else []:
                        if diagnostic.get("ok") is False:
                            message = str(diagnostic.get("reason") or diagnostic.get("stderr") or "HDL stage failed")[:1500]
                            category = ("timeout" if "timeout" in message.lower() else "missing_tool" if "ENOENT" in message
                                        else "invalid_rtl" if diagnostic.get("stage") in ("compile", "analyze") else "tool_error")
                            result["diagnostics"].append({"stage": name, "category": category, "message": message})
            for execution in metadata.get("executions", []):
                if not execution.get("ok", False):
                    reason = str(execution.get("reason") or f"Tool exited with code {execution.get('code', 'unavailable')}")
                    category = ("cancelled" if "cancel" in reason.lower() else "timeout" if "timeout" in reason.lower()
                                else "missing_tool" if "ENOENT" in reason or "not found" in reason.lower() or "missing tool" in reason.lower()
                                else "invalid_rtl" if execution.get("task") in ("compile", "compile-netlist")
                                else "tool_error")
                    result["diagnostics"].append({"stage": name, "category": category,
                                                  "message": (reason + ("\n" + log_excerpt if log_excerpt else ""))[:4500]})
        if result["cases"]:
            result["diagnostics"].append({"category": "behavior_mismatch", "message": "Observed outputs differ from the trusted expected behavior"})
        if result["status"] != "passed" and not result["diagnostics"]:
            result["diagnostics"].append({"category": "cancelled" if result["status"] == "cancelled" else "incomplete_evaluation", "message": result["message"]})
        bundle = read_json(directory / "evolution-inputs.json", 64 * 1024 * 1024)
        result["inputs_sha256"] = digest((directory / "evolution-inputs.json").read_bytes())
        result["context"] = {"definition": identity(definition),
            "fixed_inputs": {name: item["sha256"] for name, item in bundle["files"].items() if name != definition["candidate"]},
            "settings": bundle["settings"], "tools": [tools[k] for k in sorted(tools)], "runtime": sorted(runtimes),
            "evaluator": evaluator_identity()}
        if bridge.config.get("reproduction"):
            result["reproduction"] = bridge.config["reproduction"]
        result["accepted"] = result["status"] == "passed"
        if required and result["formal"]["status"] != "proven":
            result["metrics"]["combined_score"] = 0.0
        if result["status"] == "cancelled":
            result["metrics"]["combined_score"] = 0.0
        elif time.monotonic() < deadline:
            bridge.seal_report(directory, result, deadline)
        else:
            raise TimeoutError("Evaluation deadline before report publication")
    except KeyboardInterrupt:
        result["status"], result["accepted"] = "cancelled", False
        result["metrics"]["combined_score"] = 0.0
        write_json(directory / "evaluation.json", result)
        raise
    except Exception as error:
        result["status"], result["accepted"] = "inconclusive", False
        result["metrics"]["combined_score"] = 0.0
        result["message"] += "; " + str(error)[:1000]
        result.setdefault("diagnostics", []).append({"category": "timeout" if isinstance(error, TimeoutError) else "invalid_evidence", "message": str(error)[:1000]})
    write_json(directory / "evaluation.json", result)
    references = {"evidence": result["evidence"]} if len(result["evidence"]) > 1 else {}
    bridge.event("evaluation", result["message"][:3500], status=result["status"], stage="evaluation", **references,
                 metrics={key: {"value": value, "unit": definition["objective"]["unit"] if key == definition["objective"]["metric"] else "dimensionless" if key == "combined_score" else "count"}
                          for key, value in list(result["metrics"].items())[:32]}, **fields)
    return result
