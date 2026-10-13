#!/usr/bin/env python3
"""Native KLayout report-reader acceptance. Run with klayout -b -r FILE,
or Python with the optional klayout package. Missing KLayout is an error.
"""
import json
import pathlib
import runpy
import tempfile

try:
    import pya as db
    rdb = db
except ImportError:
    import klayout.db as db
    import klayout.rdb as rdb

with tempfile.TemporaryDirectory(prefix="chipsim-native-reports-") as directory:
    root = pathlib.Path(directory)

    def netlist(value):
        source = root / (str(value) + ".sp")
        source.write_text("* fixture\n.SUBCKT TOP A B\nR1 A B " + str(value) + "\n.ENDS TOP\n")
        result = db.Netlist()
        result.read(str(source), db.NetlistSpiceReader())
        return result

    for label, resistance in (("match", 10), ("mismatch", 20)):
        lvs = db.LayoutVsSchematic("TOP", 0.001)
        lvs.extract_netlist()
        lvs.netlist().assign(netlist(10))
        lvs.reference = netlist(resistance)
        assert lvs.compare(db.NetlistComparer()) == (resistance == 10)
        lvs.write(str(root / (label + ".lvsdb")))

    drc = rdb.ReportDatabase("Width rule")
    category = drc.create_category("width")
    drc.save(str(root / "clean.lyrdb"))
    cell = drc.create_cell("TOP")
    item = drc.create_item(cell.rdb_id(), category.rdb_id())
    item.add_value(rdb.RdbItemValue(db.DBox(0, 0, 1, 1)))
    drc.save(str(root / "violation.lyrdb"))
    (root / "unsupported.lyrdb").write_text("DRC not supported on this platform\n")

    def read(drc_path, lvs_path):
        request_file, result_file = root / "request.json", root / "result.json"
        request_file.write_text(json.dumps({"drc": str(root / drc_path), "lvs": str(root / lvs_path)}))
        runpy.run_path(str(pathlib.Path(__file__).with_name("design-klayout.py")),
                       init_globals={"request": str(request_file), "result": str(result_file)}, run_name="__main__")
        return json.loads(result_file.read_text())["reports"]

    clean = read("clean.lyrdb", "match.lvsdb")
    assert clean["drc"]["items"] == 0 and clean["drc"]["categories"] == 1
    assert clean["lvs"]["circuits"] == 1 and clean["lvs"]["statuses"]["Match"] > 0
    assert all(value == 0 for name, value in clean["lvs"]["statuses"].items() if name != "Match")
    bad = read("violation.lyrdb", "mismatch.lvsdb")
    assert bad["drc"]["items"] == 1
    assert bad["lvs"]["statuses"]["Mismatch"] + bad["lvs"]["statuses"]["NoMatch"] > 0
    missing = read("unsupported.lyrdb", "absent.lvsdb")
    assert missing["drc"]["error"] and missing["lvs"]["error"]
print("PASS native KLayout clean/violating DRC, matching/mismatching LVS, malformed/missing reports")
