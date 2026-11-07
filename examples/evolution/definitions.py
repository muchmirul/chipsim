"""Data-only benchmark definitions and frozen, bounded project inputs."""
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
MAX_JSON = 2 * 1024 * 1024
MAX_INPUTS = 32 * 1024 * 1024
BUILTINS = {name: HERE / (name + ".benchmark.json") for name in ("counter", "alu8")}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())


def evaluator_identity():
    files = sorted(HERE.glob("*.py")) + sorted((HERE / "alu8").glob("*.py"))
    return identity({str(path.relative_to(HERE)): digest(path.read_bytes()) for path in files})


def project_info(mode, root=None, definition_file=None):
    script = HERE.parents[1] / "src/evolution/project-info.mjs"
    process = subprocess.run(["node", str(script), mode, *([str(root), str(definition_file)] if root else [])],
                             capture_output=True, text=True, timeout=30)
    if process.returncode:
        raise ValueError(process.stderr[:2000])
    return json.loads(process.stdout)


def read_json(path, limit=MAX_JSON):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError("Expected bounded regular JSON file: " + str(path))
    data = path.read_bytes()
    if len(data) > limit:
        raise ValueError("JSON exceeds limit")
    return json.loads(data, parse_constant=lambda x: (_ for _ in ()).throw(ValueError("Nonfinite JSON: " + x)))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def local_path(value):
    if (not isinstance(value, str) or not value or len(value) > 4096
            or value.startswith("/") or re.search(r"[\x00-\x1f\\]", value)
            or any(p in ("", ".", "..") for p in value.split("/"))):
        raise ValueError("Expected relative path without traversal: " + str(value))
    return value


def regular(root, name):
    path = root
    for part in local_path(name).split("/"):
        path = path / part
        if path.is_symlink():
            raise ValueError("Symbolic links are not benchmark inputs: " + name)
    if not path.is_file():
        raise ValueError("Missing benchmark input: " + name)
    return path


def validate_definition(value):
    if not isinstance(value, dict) or value.get("format") != "chipsim-evolution-benchmark" or value.get("version") != 1:
        raise ValueError("Expected chipsim-evolution-benchmark version 1")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,127}", value.get("id", "")):
        raise ValueError("Invalid benchmark id")
    if value.get("engine", "design") not in ("design", "counter", "alu8"):
        raise ValueError("Unknown benchmark engine")
    candidate = local_path(value.get("candidate"))
    if Path(candidate).suffix not in (".v", ".sv"):
        raise ValueError("Candidate must be one Verilog/SystemVerilog file")
    files = value.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= 512 or len(files) != len(set(files)):
        raise ValueError("Benchmark files must contain 1..512 unique paths")
    for file in files:
        local_path(file)
    if candidate not in files:
        raise ValueError("Candidate must be in benchmark files")
    timeout = value.get("timeout", 60)
    if type(timeout) not in (int, float) or not 1 <= timeout <= 300:
        raise ValueError("Benchmark timeout must be 1..300 seconds")
    objective = value.get("objective", {})
    if (not isinstance(objective.get("metric"), str) or objective.get("direction") not in ("minimize", "maximize")
            or not 1 <= len(objective["metric"]) <= 64 or not isinstance(objective.get("unit"), str)
            or len(objective["unit"]) > 64):
        raise ValueError("Objective requires metric, direction, and unit")
    for key in ("description", "interface"):
        if not isinstance(value.get(key), str) or not value[key] or len(value[key]) > 4000:
            raise ValueError(key + " requires bounded text")
    stages = value.get("stages", [])
    if not isinstance(stages, list) or not 1 <= len(stages) <= 32:
        raise ValueError("Expected 1..32 ordered stages")
    targets = []
    for stage in stages:
        if not isinstance(stage, dict) or not isinstance(stage.get("target"), str):
            raise ValueError("Stage requires target")
        targets.append(stage["target"])
        report = stage.get("report")
        if report is not None:
            if not isinstance(report, dict) or not isinstance(report.get("task"), str):
                raise ValueError("Report requires task and path")
            local_path(report.get("path"))
        if "expected_checks" in stage and (type(stage["expected_checks"]) is not int or stage["expected_checks"] < 1):
            raise ValueError("expected_checks must be a positive integer")
    if len(set(targets)) != len(targets):
        raise ValueError("Duplicate stage target")
    for key in ("formal", "replay"):
        option = value.get(key)
        if option is not None:
            if not isinstance(option, dict) or not isinstance(option.get("target"), str):
                raise ValueError(key + " requires a target")
    formal = value.get("formal", {})
    if formal:
        if type(formal.get("required", False)) is not bool:
            raise ValueError("formal.required must be boolean")
        if not isinstance(formal.get("scope"), str) or not isinstance(formal.get("assumptions"), list):
            raise ValueError("Formal requires scope and assumptions")
        reference = local_path(formal.get("reference"))
        if reference == candidate or reference not in files:
            raise ValueError("Formal reference must be a fixed input distinct from the candidate")
    return value


def load_definition(selector="counter"):
    path = BUILTINS.get(str(selector), Path(selector)).absolute()
    value = validate_definition(read_json(path))
    engine = value.get("engine", "design")
    if engine in BUILTINS and value != read_json(BUILTINS[engine]):
        raise ValueError("Built-in engine definitions are fixed; use design targets for a custom benchmark")
    root = path.parent
    total = 0
    for name in value["files"]:
        total += regular(root, name).stat().st_size
    if total > MAX_INPUTS:
        raise ValueError("Benchmark inputs exceed 32 MiB")
    if value.get("engine", "design") == "design":
        if "chipsim.design.json" not in value["files"] or "chipsim.lock.json" not in value["files"]:
            raise ValueError("Custom benchmark must include design and lock manifests")
        design = read_json(root / "chipsim.design.json")
        if "publish" in design.get("tasks", {}) or "publish" in design.get("targets", {}):
            raise ValueError("publish is reserved for evaluation evidence")
        if any(name.startswith("evolution-") or name == "evaluation.json" for name in value["files"]):
            raise ValueError("Evolution report paths are reserved")
        for stage in [*value["stages"], *[value[k] for k in ("formal", "replay") if k in value]]:
            target = design.get("targets", {}).get(stage["target"])
            if not target or not target.get("requiredChecks"):
                raise ValueError("Benchmark target needs explicit required checks: " + stage["target"])
            report = stage.get("report")
            if report and not any(o.get("path") == report["path"] for o in design.get("tasks", {}).get(report["task"], {}).get("outputs", [])):
                raise ValueError("Report must identify a declared task output")
        if not any(s.get("report") for s in value["stages"]):
            raise ValueError("Custom evaluation needs a trusted stage report")
    if value.get("engine", "design") == "design":
        project_info("validate", root, path)
    return value, root


def pack(definition, root, candidate=None):
    files, total = {}, 0
    for name in definition["files"]:
        data = candidate if name == definition["candidate"] and candidate is not None else regular(root, name).read_bytes()
        total += len(data)
        if total > MAX_INPUTS:
            raise ValueError("Benchmark inputs exceed 32 MiB")
        files[name] = {"sha256": digest(data), "data": base64.b64encode(data).decode()}
    return {"format": "chipsim-evolution-inputs", "version": 1, "definition": definition, "files": files}


def unpack(bundle, destination):
    if bundle.get("format") != "chipsim-evolution-inputs" or bundle.get("version") != 1:
        raise ValueError("Expected versioned evolution inputs")
    definition = validate_definition(bundle["definition"])
    if set(bundle["files"]) != set(definition["files"]):
        raise ValueError("Snapshot file inventory differs from definition")
    decoded, total = {}, 0
    for name, item in bundle["files"].items():
        local_path(name)
        data = base64.b64decode(item["data"], validate=True)
        total += len(data)
        if digest(data) != item["sha256"] or total > MAX_INPUTS:
            raise ValueError("Damaged or oversized input snapshot")
        decoded[name] = data
    destination.mkdir()
    for name, data in decoded.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return definition


def freeze(config, session_directory):
    """Once per session; workers verify and use the frozen bytes."""
    if config.get("asset_root"):
        bundle = read_json(Path(config["asset_root"]).parent / "inputs.json", MAX_INPUTS * 2)
        if identity(bundle) != config["inputs_hash"]:
            raise ValueError("Frozen benchmark snapshot changed")
        if config.get("definition") != bundle["definition"]:
            raise ValueError("Frozen benchmark definition changed")
        for name, item in bundle["files"].items():
            if digest(regular(Path(config["asset_root"]), name).read_bytes()) != item["sha256"]:
                raise ValueError("Frozen benchmark input changed: " + name)
        return bundle["definition"]
    definition, root = load_definition(config.get("benchmark", "counter"))
    snapshot = session_directory / "benchmark-inputs"
    if snapshot.exists():
        bundle = read_json(snapshot / "inputs.json", MAX_INPUTS * 2)
        if bundle.get("definition") != definition:
            raise ValueError("This session already uses a different benchmark definition")
        config.update(asset_root=str(snapshot / "files"), inputs_hash=identity(bundle), definition=definition)
        return freeze(config, session_directory)
    bundle = pack(definition, root)
    snapshot.mkdir()
    write_json(snapshot / "inputs.json", bundle)
    unpack(bundle, snapshot / "files")
    config.update(asset_root=str(snapshot / "files"), inputs_hash=identity(bundle), definition=definition)
    return definition
