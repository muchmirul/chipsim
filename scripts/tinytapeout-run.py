#!/usr/bin/env python3
"""Execute captured official Tiny Tapeout tools, retaining native evidence.

Project provenance comes from captured inputs. The adapter explicitly selects the
locked manual PDK and lazily imports optional image rendering. HDL, timing,
physical configuration and native check algorithms remain upstream.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys


def main():
    root = Path.cwd()
    options = json.loads((root / "chipsim-tinytapeout-request.json").read_text())
    pins = json.loads((root / "flow-pins.json").read_text())
    for key in ("templateRevision", "supportRevision", "pdkRevision", "image", "librelaneVersion"):
        if pins[key] != options[key]:
            raise ValueError("Captured flow pin differs from task: " + key)
    import importlib.metadata
    if importlib.metadata.version("librelane") != options["librelaneVersion"]:
        raise ValueError("Installed LibreLane Python version differs from pin")
    sources = (Path(options["pdkRoot"]) / options["pdk"] / "SOURCES").read_text()
    if options["pdkRevision"] not in sources.split():
        raise ValueError("PDK SOURCES revision differs from pin")
    from tinytapeout_project import load_project
    Project = load_project(root / "tt")
    project = Project(0, "chipsim", ".", options["pdk"], is_user_project=True)
    project.get_git_remote = lambda: "chipsim:captured-inputs"
    project.get_git_commit_hash = lambda: "chipsim-task:" + options["fingerprint"]
    project.get_tt_tools_version = lambda: options["supportRevision"]
    # The raw, hash-locked PDK is already installed. New LibreLane releases
    # default to Ciel and may otherwise fetch a different PDK during hardening.
    if "--manual-pdk" not in project.tech.librelane_pdk_args:
        project.tech.librelane_pdk_args += " --manual-pdk"
    # yowasp exposes the working directory, not the host absolute root.
    # Keep source spelling relative for the official port-validation command.
    project.src_dir = "src"
    project.post_clone_setup()
    project.create_user_config()
    try:
        project.harden(no_docker=False)
        project.create_tt_submission()
        gds = root / "tt_submission" / (project.get_macro_name() + ".gds")
        from tinytapeout_precheck import run_precheck
        returncode = run_precheck(root, options, gds)
        if returncode:
            raise SystemExit(returncode)
    finally:
        os.chdir(root)
        (root / "out").mkdir(exist_ok=True)
        native = root / "runs/wokwi/final/metrics.json"
        resolved = root / "runs/wokwi/resolved.json"
        if native.exists() and resolved.exists():
            data = json.loads(native.read_text())
            nonfinite = [k for k, v in data.items() if isinstance(v, float) and not math.isfinite(v)]
            for key in nonfinite:
                data[key] = None
            inventory = []
            for path in [native, resolved, *sorted((root / "runs/wokwi/final").rglob("*.sdc"))]:
                content = path.read_bytes()
                inventory.append({"path": str(path.relative_to(root)), "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
            report = {"metrics": data, "nonfinite": nonfinite, "sources": inventory, "corners": json.loads(resolved.read_text()).get("STA_CORNERS")}
            (root / "out/physical.json").write_text(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
