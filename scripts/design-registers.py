#!/usr/bin/env python3
"""Normalize elaborated SystemRDL metadata; installed only with an external PeakRDL toolchain."""
import json
import sys
from systemrdl import RDLCompiler
from systemrdl.node import RegNode

compiler = RDLCompiler()
compiler.compile_file(sys.argv[1])
root = compiler.elaborate()
registers = []
for node in root.top.descendants(unroll=True):
    if not isinstance(node, RegNode):
        continue
    fields = []
    for field in node.fields():
        reset = field.get_property("reset")
        fields.append({"name": field.inst_name, "lsb": field.low, "msb": field.high,
                       "access": field.get_property("sw").name,
                       "reset": hex(reset) if isinstance(reset, int) else None})
    registers.append({"path": node.get_path(), "address": hex(node.absolute_address),
                      "width": node.get_property("regwidth"), "fields": fields})
with open(sys.argv[2], "x", encoding="utf8") as output:
    json.dump({"format": "chipsim-register-map", "version": 1, "registers": registers}, output, indent=2)
    output.write("\n")
