"""Explicit managed-project evaluation contracts and trusted metric normalization."""
import hashlib
import math
import re
from pathlib import Path, PurePosixPath

from support import read_json, write_json

MAX_FILES = 256
MAX_BYTES = 16 * 1024 * 1024


def object_fields(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise ValueError("expected exactly required workflow fields " + ", ".join(required))


def relative(value):
    if not isinstance(value, str) or not value or len(value) > 512 or "\\" in value or re.search(r"[\x00-\x1f\x7f]", value):
        raise ValueError("workflow paths must be bounded relative POSIX paths")
    path = PurePosixPath(value)
    if path.is_absolute() or any(p in ("..", ".git", ".chipsim", ".chipsim-agent", "node_modules") for p in path.parts) or value != path.as_posix() or value == ".":
        raise ValueError("workflow path must stay within the template: " + value)
    return value


def finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def load_workflow(file):
    file = Path(file).resolve(strict=True)
    value = read_json(file, 65536)
    object_fields(value, ("format", "version", "goal", "template", "files", "candidate", "language", "target", "report", "objectives"))
    if value["format"] != "chipsim-evolution-workflow" or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("expected version-1 chipsim-evolution-workflow")
    if not isinstance(value["goal"], str) or not value["goal"].strip() or len(value["goal"]) > 4000 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value["goal"]):
        raise ValueError("workflow goal must be 1..4000 characters")
    if not isinstance(value["template"], str):
        raise ValueError("workflow template must be a directory path")
    template = (file.parent / value["template"]).resolve(strict=True)
    if not template.is_dir():
        raise ValueError("workflow template must be a directory")
    candidate = relative(value["candidate"])
    suffixes = {"verilog": (".v", ".sv"), "vhdl": (".vhd", ".vhdl")}
    if not isinstance(value["language"], str) or value["language"] not in suffixes or not candidate.endswith(suffixes[value["language"]]):
        raise ValueError("workflow candidate extension must match Verilog or VHDL language")
    if not isinstance(value["target"], str) or not value["target"] or len(value["target"]) > 128:
        raise ValueError("workflow target must be a managed target identifier")
    if not isinstance(value["files"], list) or not value["files"] or len(value["files"]) > MAX_FILES:
        raise ValueError("workflow files must list 1..256 explicit regular files")
    files = [relative(name) for name in value["files"]]
    if len(set(files)) != len(files) or not {candidate, "chipsim.design.json", "chipsim.lock.json"}.issubset(files):
        raise ValueError("workflow files must be unique and include candidate and both design manifests")
    hashes, total = {}, 0
    for name in files:
        path = template / name
        if path.resolve(strict=True) != path.absolute() or not path.is_file():
            raise ValueError("workflow input must be a regular file without symlink components: " + name)
        size = path.stat().st_size
        if size > 4 * 1024 * 1024 or total + size > MAX_BYTES:
            raise ValueError("workflow inputs exceed 4 MiB/file or 16 MiB total")
        data = path.read_bytes()
        total += len(data)
        if len(data) > 4 * 1024 * 1024 or total > MAX_BYTES:
            raise ValueError("workflow input grew beyond its byte limit")
        hashes[name] = hashlib.sha256(data).hexdigest()
    design = read_json(template / "chipsim.design.json")
    if not isinstance(design, dict) or design.get("format") != "chipsim-design" or design.get("version") != 1:
        raise ValueError("workflow needs a version-1 managed design")
    if not isinstance(design.get("tasks"), dict) or not isinstance(design.get("targets"), dict):
        raise ValueError("workflow design must declare tasks and targets")
    target = design.get("targets", {}).get(value["target"], {})
    if not isinstance(target, dict) or not isinstance(target.get("tasks"), list) or not target["tasks"] or not isinstance(target.get("requiredChecks"), list) or not target["requiredChecks"]:
        raise ValueError("workflow target must declare tasks and nonempty required correctness/constraint checks")
    report = value["report"]
    object_fields(report, ("task", "path"))
    relative(report["path"])
    if not isinstance(report["task"], str) or report["task"] not in design.get("tasks", {}):
        raise ValueError("workflow report must name a declared task")
    producer = design["tasks"][report["task"]]
    declared = producer.get("outputs", []) if isinstance(producer, dict) else []
    if not isinstance(declared, list) or not any(isinstance(output, dict) and output.get("path") == report["path"] and output.get("required", True) is True for output in declared):
        raise ValueError("workflow metric report must be a required output of its named producer task")
    reachable, pending = set(), list(target["tasks"])
    while pending:
        name = pending.pop()
        if not isinstance(name, str) or name not in design.get("tasks", {}):
            raise ValueError("workflow target references an unknown task")
        if name in reachable:
            continue
        reachable.add(name)
        task = design["tasks"][name]
        if not isinstance(task, dict) or not isinstance(task.get("needs", []), list) or not isinstance(task.get("bindings", []), list) or any(not isinstance(binding, dict) or not isinstance(binding.get("task"), str) for binding in task.get("bindings", [])):
            raise ValueError("workflow needs valid task dependencies/bindings")
        pending.extend(task.get("needs", []))
        pending.extend(binding["task"] for binding in task.get("bindings", []))
    if report["task"] not in reachable:
        raise ValueError("workflow report producer must be reachable from the evaluation target")
    objectives = value["objectives"]
    if not isinstance(objectives, list) or not 1 <= len(objectives) <= 16:
        raise ValueError("workflow needs 1..16 metric objectives")
    names = set()
    for item in objectives:
        object_fields(item, ("name", "unit", "direction", "range", "weight"))
        name, unit = item["name"], item["unit"]
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", name) or name == "combined_score" or name in names:
            raise ValueError("objective names must be unique, bounded and not combined_score")
        names.add(name)
        if not isinstance(unit, str) or not unit or len(unit) > 64 or re.search(r"[\x00-\x1f\x7f]", unit) or item["direction"] not in ("minimize", "maximize"):
            raise ValueError("each objective needs units and minimize/maximize direction")
        bounds = item["range"]
        if not isinstance(bounds, list) or len(bounds) != 2 or not all(finite(v) for v in bounds) or bounds[0] >= bounds[1] or not finite(bounds[1] - bounds[0]):
            raise ValueError("objective range must be two increasing finite numbers")
        if not finite(item["weight"]) or not 0 < item["weight"] <= 1000000:
            raise ValueError("objective weight must be finite and positive, at most 1000000")
    return {**value, "template": str(template), "files": files, "sha256": hashes}


def copy_inputs(workflow, destination):
    destination = Path(destination)
    destination.mkdir()
    for name, expected in workflow["sha256"].items():
        source = Path(workflow["template"]) / name
        if source.resolve(strict=True) != source.absolute() or not source.is_file() or source.stat().st_size > 4 * 1024 * 1024:
            raise ValueError("changed or invalid trusted workflow input: " + name)
        with source.open("rb") as input_file:
            data = input_file.read(4 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("trusted workflow input fingerprint changed: " + name)
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def freeze_workflow(workflow, directory):
    snapshot = Path(directory) / "trusted"
    copy_inputs(workflow, snapshot)
    frozen = {**workflow, "template": str(snapshot)}
    write_json(Path(directory) / "workflow.json", frozen, exclusive=True)
    return frozen


def measured_metrics(workflow, report):
    if not isinstance(report, dict):
        raise ValueError("trusted metric report must be an object")
    metrics, units, weighted, weights = {}, {}, 0.0, 0.0
    for objective in workflow["objectives"]:
        name = objective["name"]
        item = report.get(name)
        if not isinstance(item, dict) or not finite(item.get("value")) or item.get("unit") != objective["unit"]:
            raise ValueError("missing, nonfinite or wrong-unit measured objective: " + name)
        value = item["value"]
        lo, hi = objective["range"]
        utility = max(0.0, min(1.0, (value - lo) / (hi - lo)))
        if objective["direction"] == "minimize":
            utility = 1.0 - utility
        weighted += utility * objective["weight"]
        weights += objective["weight"]
        metrics[name], units[name] = value, objective["unit"]
    metrics["combined_score"], units["combined_score"] = weighted / weights, "fraction"
    return metrics, units
