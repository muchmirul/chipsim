"""Shared, bounded human and optimizer feedback; offline report comparison."""
import json
import math
import re
from definitions import identity, read_json


def clean(value):
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", "?", str(value))


def read_report(path):
    value = read_json(path)
    if value.get("format") == "chipsim-evolution-result":
        value = value.get("result", {})
    if value.get("format") != "chipsim-evolution-evaluation" or value.get("version") not in (1, 2):
        raise ValueError("Expected evolution evaluation report version 1 or 2")
    if not isinstance(value.get("metrics"), dict) or value.get("status") not in ("passed", "failed", "inconclusive", "cancelled"):
        raise ValueError("Malformed evaluation report")
    for v in value["metrics"].values():
        if type(v) not in (int, float) or not math.isfinite(v):
            raise ValueError("Report metrics must be finite numbers")
    return value


def cases(result):
    if "cases" in result:
        return result["cases"][:16]
    entries = []
    for i, failure in enumerate(result.get("failures", [])[:16]):
        if "opcode" in failure:
            inputs = {key: failure[key] for key in ("A", "B", "opcode")}
            check = "ALU operation " + str(failure["opcode"])
        else:
            inputs = failure.get("inputs", {"cycle": failure.get("cycle")})
            check = "counter recurrence"
        entries.append({"id": i, "check": check, "inputs": inputs,
                        "expected": failure.get("expected"), "observed": failure.get("observed"),
                        **({"cycle": failure["cycle"]} if "cycle" in failure else {})})
    return entries


def render_report(result, limit=None):
    lines = ["Candidate: " + result.get("candidate", "unavailable"),
             "Benchmark: " + result.get("benchmark", "unavailable"),
             "Status: " + result.get("status", "unavailable").upper(),
             "Acceptance: " + ("passed" if result.get("accepted", result.get("status") == "passed") else "not accepted"),
             result.get("message", "")]
    for name, stage in result.get("stages", {}).items():
        lines.append(f"Stage {name}: {stage.get('outcome', stage.get('state', 'unavailable'))}")
    for diagnostic in result.get("diagnostics", []):
        lines.append(f"{diagnostic.get('category', 'diagnostic')}: {diagnostic.get('message', '')}")
    for name, value in result.get("metrics", {}).items():
        lines.append(f"{name}: {value}")
    for case in cases(result):
        lines += [f"Case {case['id']}: {case.get('check', 'check')}",
                  "  Inputs: " + json.dumps(case.get("inputs", {}), sort_keys=True),
                  "  Expected: " + json.dumps(case.get("expected"), sort_keys=True),
                  "  Observed: " + json.dumps(case.get("observed"), sort_keys=True)]
    if result.get("formal"):
        formal = result["formal"]
        lines.append("Formal: " + formal["status"] + "; " + formal.get("scope", ""))
    if result.get("verification_error"):
        lines.append("Evidence verification: " + result["verification_error"])
    if result.get("report_evidence"):
        lines.append("Evidence: " + json.dumps(result["report_evidence"], sort_keys=True))
    lines.append("Agent-reported benchmark results; follow stage evidence. Cell counts are not physical area or timing.")
    output = clean("\n".join(lines)) + "\n"
    return output if limit is None else output[:limit] + ("\nFurther details: see saved report.\n" if len(output) > limit else "")


def compare(left, right):
    reasons = []
    for key in ("definition", "fixed_inputs", "settings", "tools", "runtime", "evaluator"):
        a, b = left.get("context", {}).get(key), right.get("context", {}).get(key)
        if a is None or b is None:
            reasons.append(key + ": comparison context unavailable")
        elif a != b:
            reasons.append(key + ": evaluation contexts differ")
    if not left.get("verified") or not right.get("verified"):
        reasons.append("Verified sealed evidence is required for ranking")
    metrics = []
    for name in sorted(set(left["metrics"]) | set(right["metrics"])):
        a, b = left["metrics"].get(name), right["metrics"].get(name)
        metrics.append({"name": name, "before": a, "after": b,
                        "delta": b - a if a is not None and b is not None else None,
                        "percent": (b - a) / abs(a) * 100 if a not in (None, 0) and b is not None else None})
    checks = []
    def check_map(report):
        return {stage + ":" + c["task"] + ":" + c["name"]: c["verdict"]
                for stage, item in report.get("stages", {}).items() for c in item.get("checks", [])}
    a_checks, b_checks = check_map(left), check_map(right)
    for name in sorted(set(a_checks) | set(b_checks)):
        if a_checks.get(name) != b_checks.get(name):
            checks.append({"check": name, "before": a_checks.get(name), "after": b_checks.get(name)})
    winner = None
    if not reasons:
        accepted = [r.get("accepted", False) for r in (left, right)]
        if accepted[0] != accepted[1]:
            winner = "before" if accepted[0] else "after"
        elif all(accepted):
            objective = left.get("objective", {})
            a, b = (r["metrics"].get(objective.get("metric")) for r in (left, right))
            if a is None or b is None:
                reasons.append("Objective measurement unavailable")
            else:
                winner = "tie" if a == b else ("after" if (b < a) == (objective["direction"] == "minimize") else "before")
    return {"comparable": not reasons, "reasons": reasons, "winner": winner,
            "metrics": metrics, "checks": checks,
            "scope": "Candidate acceptance and declared objective under matching captured evaluation context"}


def render_comparison(result):
    lines = ["Comparable: " + ("yes" if result["comparable"] else "no"),
             "Winner: " + (result["winner"] or "not ranked")]
    lines.extend(result["reasons"])
    for row in result["metrics"]:
        percent = "" if row["percent"] is None else f" ({row['percent']:+.2f}%)"
        lines.append(f"{row['name']}: {row['before']} -> {row['after']}{percent}")
    for row in result["checks"]:
        lines.append(f"{row['check']}: {row['before']} -> {row['after']}")
    return clean("\n".join(lines)) + "\n"
