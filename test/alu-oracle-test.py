"""Independent expectations and malformed-evidence cases, without EDA tools."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

TRUSTED = Path(__file__).resolve().parents[1] / "examples/evolution/alu8/trusted"
sys.path.insert(0, str(TRUSTED))
from oracle import reference, vectors, vector_bytes, fingerprint
from score import score
from cost import cost
sys.path.insert(0, str(TRUSTED.parents[1]))
from alu8.benchmark import validate_checks, replay_testbench
from evaluator import Bridge


class OracleTests(unittest.TestCase):
    def test_verification_cannot_accept_a_stage_after_its_deadline(self):
        bridge = Bridge.__new__(Bridge)
        with tempfile.TemporaryDirectory() as directory:
            bridge.cancel_file = Path(directory) / "CANCEL"
            job = {"id": "job", "state": "completed"}
            bridge.cli = lambda *args: {"job": job}
            bridge.collect_artifacts = lambda *args: {}
            with patch("evaluator.time.monotonic", side_effect=[0, 2]):
                with self.assertRaisesRegex(TimeoutError, "while verifying"):
                    bridge.run_stage(Path(directory), "test", 1)
            self.assertIsNone(bridge.active)

    def test_replay_has_only_its_bounded_vector_memory(self):
        for count in (1, 16, 288):
            source = replay_testbench(count)
            self.assertIn(f"vectors [0:{count - 1}]", source)
            self.assertIn(f"count = {count};", source)
            self.assertNotIn("vectors [0:524287]", source)
        for count in (0, 289):
            with self.assertRaises(ValueError):
                replay_testbench(count)

    def test_arithmetic_flags_and_operations(self):
        cases = [
            (255, 1, 0, (0, 1, 1, 0)), (127, 1, 0, (128, 0, 0, 1)),
            (128, 128, 0, (0, 1, 1, 1)), (0, 1, 1, (255, 0, 0, 0)),
            (128, 1, 1, (127, 1, 0, 1)), (127, 255, 1, (128, 0, 0, 1)),
            (5, 5, 1, (0, 1, 1, 0)), (240, 15, 2, (0, 0, 1, 0)),
            (240, 15, 3, (255, 0, 0, 0)), (170, 255, 4, (85, 0, 0, 0)),
            (255, 77, 5, (0, 0, 1, 0)), (128, 99, 6, (0, 0, 1, 0)),
            (255, 255, 7, (127, 0, 0, 0)),
        ]
        for a, b, op, expected in cases:
            self.assertEqual(tuple(reference(a, b, op).values()), expected)

    def test_vectors_are_complete_and_reproducible(self):
        self.assertEqual(len(list(vectors("directed"))), 288)
        self.assertEqual(fingerprint(vector_bytes("random")), "e37e235eb1f6d237a8d746e235ac44dedb521183a37051aa51de414f6926c850")
        observed = {(a << 11) | (b << 3) | op for a, b, op in vectors("exhaustive")}
        self.assertEqual(observed, set(range(524288)))

    def test_reports_fail_unknowns_and_reject_incomplete_or_changed_stimulus(self):
        rows = []
        for a, b, op in vectors("directed"):
            expected = reference(a, b, op)
            rows.append(f"{(a << 11) | (b << 3) | op:05x} {expected['result']:02x} {expected['carry']}{expected['zero']}{expected['overflow']}\n")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "observations.txt"
            path.write_text("".join(rows))
            self.assertTrue(score("directed", path)["correct"])
            report = score("directed", path)
            validate_checks("directed", report)
            for key, value in (("checks_total", 1), ("vectors_sha256", "0" * 64), ("correct", 1)):
                changed = {**report, key: value}
                with self.assertRaises(ValueError):
                    validate_checks("directed", changed)
            unknown = rows.copy()
            unknown[0] = unknown[0].replace(" 00 ", " xx ")
            path.write_text("".join(unknown))
            result = score("directed", path)
            self.assertEqual(result["checks_passed"], 287)
            self.assertEqual(result["failures"][0]["observed"]["result"], "xx")
            for invalid in (rows[:-1], rows + rows[:1], rows[1:] + rows[:1], ["malformed\n"] + rows[1:]):
                path.write_text("".join(invalid))
                with self.assertRaises(ValueError):
                    score("directed", path)

    def test_cost_rejects_unresolved_or_stateful_hardware(self):
        ports = {key: {"direction": direction, "bits": [0] * width} for key, direction, width in (
            ("A", "input", 8), ("B", "input", 8), ("opcode", "input", 3),
            ("result", "output", 8), ("carry", "output", 1), ("zero", "output", 1), ("overflow", "output", 1))}
        module = {"ports": ports, "cells": {"gate": {"type": "$_AND_"}}}
        self.assertEqual(cost({"modules": {"alu": module}})["cell_count"], 1)
        for kind in ("$_DFF_P_", "$_DLATCH_P_", "unknown"):
            module["cells"]["gate"]["type"] = kind
            with self.assertRaises(ValueError):
                cost({"modules": {"alu": module}})

    def test_exact_run_artifacts_cannot_be_substituted(self):
        bridge = Bridge.__new__(Bridge)
        records = {
            "run": {"attempts": ["attempt"], "artifacts": ["metric"]},
            "attempt": {"job": "job", "task": "score", "artifacts": ["metric"]},
            "metric": {"id": "metric", "path": "metrics.json", "producer": {"job": "job", "task": "simulate"}},
        }
        def cli(*args):
            if args[1] == "verify":
                return {}
            if args[1] == "list":
                return {"artifacts": [records["metric"]], "nextOffset": None}
            record = records[args[2]]
            return {"artifact" if args[2] == "metric" else "record": record}
        bridge.cli = cli
        with self.assertRaises(ValueError):
            bridge.collect_artifacts(Path("."), {"id": "job", "run": "run"})
        records["metric"]["producer"]["task"] = "score"
        self.assertEqual(bridge.collect_artifacts(Path("."), {"id": "job", "run": "run"}), {"score:metrics.json": "metric"})


if __name__ == "__main__":
    unittest.main()
