"""Read actual flattened Yosys netlist cells; reject unsupported ALU hardware."""
import json
from pathlib import Path
import sys

ALLOWED = {"$_" + name + "_" for name in (
    "NOT", "BUF", "AND", "NAND", "OR", "NOR", "XOR", "XNOR", "ANDNOT", "ORNOT", "MUX", "NMUX", "AOI3", "OAI3", "AOI4", "OAI4")}


def cost(netlist):
    modules = netlist.get("modules", {})
    if set(modules) != {"alu"}:
        raise ValueError("expected one flattened alu module")
    module = modules["alu"]
    if module.get("memories") or any(int(module.get("attributes", {}).get(k, "0"), 2) for k in ("blackbox", "whitebox")):
        raise ValueError("unsupported ALU memories or blackboxes")
    ports = {k: (v["direction"], len(v["bits"])) for k, v in module["ports"].items()}
    if ports != {"A": ("input", 8), "B": ("input", 8), "opcode": ("input", 3),
                 "result": ("output", 8), "carry": ("output", 1), "zero": ("output", 1), "overflow": ("output", 1)}:
        raise ValueError("changed ALU interface")
    cells = module.get("cells", {})
    if any(cell["type"] not in ALLOWED for cell in cells.values()):
        raise ValueError("non-combinational or unresolved synthesized cell")
    return {"format": "chipsim-alu-cost", "version": 1, "cell_count": len(cells),
            "metric_scope": "generic Yosys cells; not physical area, timing or power"}


if __name__ == "__main__":
    source, destination = map(Path, sys.argv[1:])
    if source.is_symlink() or source.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("invalid netlist file")
    result = cost(json.loads(source.read_text()))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2) + "\n")
