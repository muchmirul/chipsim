#!/usr/bin/env python3
"""Execute captured official Tiny Tapeout tools, retaining native evidence.

The only Project overrides replace Git metadata unavailable in a content-addressed
job workspace. They do not alter HDL, timing, physical configuration or checks.
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
    sys.path.insert(0, str(root / "tt"))
    from project import Project
    project = Project(0, "chipsim", ".", options["pdk"], is_user_project=True)
    project.get_git_remote = lambda: "chipsim:captured-inputs"
    project.get_git_commit_hash = lambda: "chipsim-task:" + options["fingerprint"]
    project.get_tt_tools_version = lambda: options["supportRevision"]
    # yowasp exposes the working directory, not the host absolute root.
    # Keep source spelling relative for the official port-validation command.
    project.src_dir = "src"
    project.post_clone_setup()
    project.create_user_config()
    try:
        project.harden(no_docker=False)
        project.create_tt_submission()
        gds = root / "tt_submission" / (project.get_macro_name() + ".gds")
        # Precheck resolves its technology templates relative to tt/precheck.
        # Its native KLayout subprocess uses the same pinned container as harden.
        bindir = root / "out/bin"
        bindir.mkdir(parents=True, exist_ok=True)
        precheck_dir = root / "tt/precheck"
        klayout = bindir / "klayout"
        docker = ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                  "-v", f"{root}:{root}", "-v", f"{options['pdkRoot']}:{options['pdkRoot']}:ro",
                  "-e", f"PDK_ROOT={options['pdkRoot']}", "-w", str(precheck_dir),
                  "--entrypoint", "klayout", options["image"]]
        klayout.write_text("#!/usr/bin/env python3\nimport os, sys\nos.execvp('docker', " + repr(docker) + " + sys.argv[1:])\n")
        klayout.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
        result = subprocess.run([options["precheckPython"], str(precheck_dir / "precheck.py"), "--gds", str(gds), "--tech", options["pdk"]], cwd=precheck_dir, env=env)
        if result.returncode:
            raise SystemExit(result.returncode)
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
