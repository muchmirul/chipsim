"""Capture benchmark inputs or evaluate one candidate in a managed workspace."""
import hashlib
import json
from pathlib import Path
import sys
import uuid

INSTALL = Path(__file__).resolve().parents[2]
EXAMPLES = INSTALL / "examples"


def evaluator_version(weighted):
    root = EXAMPLES / ("evolutionary-example" if weighted else "evolution")
    hash_input = hashlib.sha256()
    for file in sorted(root.rglob("*.py")):
        hash_input.update(str(file.relative_to(root)).encode() + b"\0")
        hash_input.update(hashlib.sha256(file.read_bytes()).digest())
    return hash_input.hexdigest()


def prepare(root, selector, formal):
    builtin = selector in ("counter", "alu8")
    if builtin:
        path = EXAMPLES / "evolution" / (selector + ".benchmark.json")
    else:
        path = (root / selector).resolve(strict=True)
        path.relative_to(root)
    with path.open("rb") as source:
        raw = source.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Benchmark definition exceeds 2 MiB")
    data = json.loads(raw)
    weighted = data.get("format") == "chipsim-evolution-workflow"
    if weighted:
        template = (path.parent / data["template"]).resolve(strict=True).relative_to(root)
        if set(template.parts) & {".git", ".chipsim", ".chipsim-agent", "node_modules"}:
            raise ValueError("Expected a project source template")
        sys.path.insert(0, str(EXAMPLES / "evolutionary-example"))
        from workflow import load_workflow
        definition = load_workflow(path)
        assets = Path(definition.pop("template"))
        if formal:
            raise ValueError("Declare required proofs in the workflow target")
    else:
        sys.path.insert(0, str(EXAMPLES / "evolution"))
        from definitions import load_definition
        definition, assets = load_definition(path)
        if formal and not definition.get("formal"):
            raise ValueError("Benchmark has no formal recipe")
    print(json.dumps(dict(definition=definition, assets=str(assets), weighted=weighted,
                          evaluator=evaluator_version(weighted))))


def evaluate(node):
    workspace = Path.cwd()
    spec = json.loads((workspace / "benchmark.json").read_bytes())
    definition, weighted = spec["definition"], spec["weighted"]
    if spec["evaluator"] != evaluator_version(weighted):
        raise ValueError("Benchmark evaluator changed since preparation")
    work = workspace / ".chipsim" / "benchmark"
    work.mkdir(parents=True)
    config = dict(project=str(work), standalone=True, session=str(uuid.uuid4()), managed_directory=str(work / "attempts"),
                  chipsim=[node, str(INSTALL / "scripts" / "chipsim.mjs")],
                  formal=spec["formal"], debug=False, timeout=definition.get("timeout", 300))
    source = workspace / "proposal.rtl"
    if weighted:
        sys.path.insert(0, str(EXAMPLES / "evolutionary-example"))
        from evaluator import Bridge
        config["workflow"] = dict(definition, template=str(workspace / "assets"))
        config["suffix"] = Path(definition["candidate"]).suffix
        config["language"] = definition["language"]
        result = Bridge(config).evaluate(source)
        measured = result["measured"] and result["status"] in ("passed", "failed")
    else:
        sys.path.insert(0, str(EXAMPLES / "evolution"))
        from definitions import pack, identity, write_json
        from evaluator import Bridge
        from verification import verify_report
        assets = workspace / "assets"
        bundle = pack(definition, assets)
        write_json(workspace / "inputs.json", bundle)
        config.update(definition=definition, asset_root=str(assets), inputs_hash=identity(bundle),
                      benchmark=definition.get("engine", definition["id"]))
        bridge = Bridge(config)
        result = bridge.evaluate(source)
        verify_report(bridge, result)
        diagnostics = {d.get("category") for d in result.get("diagnostics", [])}
        metrics = result["metrics"]
        failed_checks = metrics.get("checks_passed", 0) < metrics.get("checks_total", 0)
        measured = result["accepted"] or (
            result["status"] == "failed"
            and not diagnostics.intersection({"missing_tool", "timeout", "cancelled", "invalid_evidence"})
            and (failed_checks or bool(result.get("cases")) or "invalid_rtl" in diagnostics)
        )
    # Persist the complete domain report even when the tool could not measure the design.
    (workspace / "result.json").write_text(json.dumps(result, allow_nan=False))
    if not measured:
        raise ValueError(result["message"])


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        prepare(Path(sys.argv[2]), sys.argv[3], sys.argv[4] == "true")
    else:
        evaluate(sys.argv[2])
