"""Provider-free contracts: malformed evidence, comparison and replay semantics."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples/evolution"))
from definitions import load_definition, validate_definition, pack, unpack, local_path, freeze
from feedback import compare, render_report, read_report
from custom import validate_stage
from replay_score import score


class WorkflowTests(unittest.TestCase):
    def test_repeated_manual_evaluations_reuse_and_verify_session_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            first = {"benchmark": "counter"}
            freeze(first, Path(temp))
            second = {"benchmark": "counter"}
            freeze(second, Path(temp))
            self.assertEqual(first["inputs_hash"], second["inputs_hash"])
            self.assertEqual(first["asset_root"], second["asset_root"])
            (Path(first["asset_root"]) / "trusted/score.py").write_text("changed")
            with self.assertRaisesRegex(ValueError, "changed"):
                freeze(second, Path(temp))

    def test_snapshots_detect_substitution_and_preserve_candidate(self):
        definition, root = load_definition("counter")
        bundle = pack(definition, root, b"original candidate")
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "files"
            unpack(bundle, destination)
            self.assertEqual((destination / definition["candidate"]).read_bytes(), b"original candidate")
            bad = copy.deepcopy(bundle)
            bad["files"]["counter.sv"]["data"] = "Y2hhbmdlZA=="
            with self.assertRaisesRegex(ValueError, "Damaged"):
                unpack(bad, Path(temp) / "bad")
            self.assertFalse((Path(temp) / "bad").exists())

    def test_definition_rejects_invalid_paths_and_reference(self):
        definition, _ = load_definition("counter")
        for path in ("../test", "/absolute", "a/../b", "a\\b", "a//b", "x\n"):
            with self.assertRaises(ValueError):
                local_path(path)
        bad = copy.deepcopy(definition)
        bad["formal"]["reference"] = bad["candidate"]
        with self.assertRaisesRegex(ValueError, "distinct"):
            validate_definition(bad)
        bad = copy.deepcopy(definition)
        bad["stages"] *= 2
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            validate_definition(bad)

    def test_comparison_requires_matching_verified_context(self):
        context = {k: "same" for k in ("definition", "fixed_inputs", "settings", "tools", "runtime", "evaluator")}
        left = {"context": context, "verified": True, "accepted": True,
                "objective": {"metric": "cells", "direction": "minimize"}, "metrics": {"cells": 100}}
        right = copy.deepcopy(left)
        right["metrics"]["cells"] = 75
        result = compare(left, right)
        self.assertEqual(result["winner"], "after")
        self.assertEqual(result["metrics"][0]["percent"], -25)
        right["accepted"] = False
        self.assertEqual(compare(left, right)["winner"], "before")
        right["context"]["tools"] = "different"
        self.assertIsNone(compare(left, right)["winner"])
        self.assertFalse(compare(left, right)["comparable"])
        right = copy.deepcopy(left)
        right["verified"] = False
        self.assertIsNone(compare(left, right)["winner"])
        left["metrics"]["cells"] = 0
        self.assertIsNone(compare(left, right)["metrics"][0]["percent"])

    def test_stage_reports_are_bounded_finite_and_complete(self):
        report = {"format": "chipsim-evolution-stage", "version": 1,
                  "metrics": {"combined_score": 1, "checks_total": 80, "checks_passed": 80}, "cases": []}
        validate_stage(report, {"expected_checks": 80})
        for change in ({"combined_score": float("nan")}, {"checks_total": 79}, {"checks_passed": True}):
            bad = copy.deepcopy(report)
            bad["metrics"].update(change)
            with self.assertRaises(ValueError):
                validate_stage(bad, {"expected_checks": 80})
        report["cases"] = [{}]
        with self.assertRaisesRegex(ValueError, "Failure case"):
            validate_stage(report, {})

    def test_legacy_reports_have_no_invented_cases_or_context(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "old.json"
            path.write_text(json.dumps({"format": "chipsim-evolution-evaluation", "version": 1,
                "status": "failed", "metrics": {"combined_score": 0}}))
            result = read_report(path)
            self.assertNotIn("cases", result)
            self.assertFalse(compare(result, result)["comparable"])
            text = render_report({**result, "message": "unsafe\x1b[2J"})
            self.assertNotIn("\x1b", text)
            self.assertIn("not accepted", text)

    def test_counter_replay_requires_full_prefix(self):
        # Actual four-cycle waveform with the known counter bug (ignoring enable).
        events = []
        for cycle in range(4):
            events += [{"time": str(cycle * 10), "changes": {"counter_tb.clk": "0", "counter_tb.reset": str(int(cycle == 0)), "counter_tb.enable": str(int(cycle != 3))}},
                       {"time": str(cycle * 10 + 5), "changes": {"counter_tb.clk": "1", "counter_tb.count": format(cycle, "04b")}}]
        events.append({"time": "40", "changes": {"counter_tb.clk": "0"}})
        wave = {"format": "chipsim-waveform", "version": 1, "timescale": {"magnitude": 1, "unit": "ns"},
                "signals": [{"id": "counter_tb." + key, "width": width} for key, width in (("clk",1),("reset",1),("enable",1),("count",4))], "events": events}
        case = {"cycle": 3, "expected": 2, "observed": "0011"}
        self.assertTrue(score("counter", wave, case)["reproduced"])
        wave["events"][0]["changes"]["counter_tb.reset"] = "0"
        with self.assertRaisesRegex(ValueError, "history"):
            score("counter", wave, case)


if __name__ == "__main__":
    unittest.main()
