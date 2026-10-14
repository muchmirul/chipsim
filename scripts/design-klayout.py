#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Muchmirul Yusa Setiaji
# Independently licensed KLayout script; see ../LICENSE or the repository LICENSE.
"""Read native verification databases during an explicit managed tool run.

KLayout: -b -r design-klayout.py -rd request=FILE -rd result=FILE
Python with the optional klayout package: design-klayout.py FILE FILE
No comparison is rerun and no report text is interpreted as code.
"""
import hashlib
import json
import pathlib
import sys

try:
    import pya as db
    rdb = db
except ImportError:
    import klayout.db as db
    import klayout.rdb as rdb


def inspect_report(kind, filename):
    path = pathlib.Path(filename)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 2 * 1024**3:
        raise ValueError("Expected a regular native report no larger than 2 GiB")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    base = {"sha256": digest.hexdigest(), "bytes": path.stat().st_size}
    if kind == "drc":
        report = rdb.ReportDatabase()
        report.load(str(path))
        categories = sum(1 for _ in report.each_category())
        return dict(base, items=report.num_items(), categories=categories)
    report = db.LayoutVsSchematic()
    report.read(str(path))
    xref = report.xref()
    if xref is None:
        raise ValueError("LVS database contains no comparison")
    counts = {"Match": 0, "MatchWithWarning": 0, "Mismatch": 0,
              "NoMatch": 0, "Skipped": 0, "None": 0, "Unknown": 0}
    statuses = {name: getattr(db.NetlistCrossReference, name.replace("None", "None_"))
                for name in counts if name != "Unknown"}

    def count(pair):
        name = next((name for name, value in statuses.items() if pair.status() == value), "Unknown")
        counts[name] += 1

    circuits = 0
    # Include subordinate comparisons: warnings on devices can mean unequal
    # parameters even when topology matches. They require review, never pass.
    for pair in xref.each_circuit_pair():
        circuits += 1
        count(pair)
        for iterator in (xref.each_net_pair, xref.each_device_pair,
                         xref.each_pin_pair, xref.each_subcircuit_pair):
            for child in iterator(pair):
                count(child)
    return dict(base, circuits=circuits, statuses=counts,
                extractionErrors=sum(1 for _ in report.each_error()))


def main(request_file, result_file):
    request_data = json.loads(pathlib.Path(request_file).read_text())
    results = {}
    for kind in ("drc", "lvs"):
        if kind in request_data:
            try:
                results[kind] = dict(inspect_report(kind, request_data[kind]), error=None)
            except Exception as error:
                results[kind] = {"error": str(error)[:4096]}
    pathlib.Path(result_file).write_text(json.dumps({
        "format": "chipsim-klayout-reports", "version": 1, "reports": results,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main(globals().get("request") or sys.argv[1], globals().get("result") or sys.argv[2])
