"""Read-only verification of report links and reproduction prerequisites."""
from pathlib import Path
import shutil

from definitions import digest, read_json, evaluator_identity, identity, project_info


def artifact_payload(bridge, evidence):
    bridge.cli("artifact", "verify", evidence["run"], "--project", evidence["project"])
    record = bridge.cli("artifact", "inspect", evidence["artifact"], "--project", evidence["project"])
    run = bridge.cli("artifact", "inspect", evidence["run"], "--project", evidence["project"])["record"]
    if (evidence["artifact"] not in run["artifacts"] or record["artifact"]["producer"]["job"] != evidence["job"]):
        raise ValueError("Evidence belongs to another producer")
    return Path(record["payloadPath"])


def verify_report(bridge, result):
    if not result.get("report_evidence"):
        raise ValueError("Report has no sealed evidence link")
    payload = artifact_payload(bridge, result["report_evidence"])
    sealed = read_json(payload)
    extra = {"session", "selected", "report_artifact", "report_evidence", "input_evidence", "verified", "verification_error"}
    if {k: v for k, v in result.items() if k not in extra} != sealed:
        raise ValueError("Report differs from its sealed artifact")
    for stage in result.get("stages", {}).values():
        if stage.get("run"):
            bridge.cli("artifact", "verify", stage["run"], "--project", stage["project"])
    return result


def reproduction_inputs(bridge, result):
    verify_report(bridge, result)
    if result.get("version") != 2 or not result.get("input_evidence"):
        raise ValueError("Report has no version 2 reproduction snapshot")
    path = artifact_payload(bridge, result["input_evidence"])
    if digest(path.read_bytes()) != result["inputs_sha256"]:
        raise ValueError("Input artifact differs from the sealed report")
    if result.get("context", {}).get("evaluator") != evaluator_identity():
        raise ValueError("Reproduction requires the recorded evaluator implementation")
    runtime = identity(project_info("runtime"))
    if result.get("context", {}).get("runtime") != [runtime]:
        raise ValueError("Reproduction requires the recorded ChipSim runtime")
    for tool in result.get("context", {}).get("tools", []):
        installed = shutil.which(tool["command"])
        if not tool.get("available") or not installed or digest(Path(installed).read_bytes()) != tool.get("sha256"):
            raise ValueError("Reproduction requires the recorded tool executable: " + tool["command"])
    return read_json(path, 64 * 1024 * 1024)
