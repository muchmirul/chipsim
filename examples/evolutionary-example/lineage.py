"""Import observed OpenEvolve checkpoint ancestry without guessing callback order."""
import hashlib
import json
from itertools import islice
from pathlib import Path
import re
import uuid

from support import read_json


class Lineage:
    def __init__(self, bridge):
        self.bridge = bridge
        self.programs = {}
        self.evaluations = {}
        self.published = {}

    def update(self):
        directory = self.bridge.directory
        for path in islice(directory.iterdir(), 1024):
            if not path.is_dir() or path.is_symlink() or not re.fullmatch(r"[0-9a-f-]{36}", path.name):
                continue
            try:
                result = read_json(path / "evaluation.json", 262144)
                if isinstance(result, dict) and result.get("candidate") == "eval-" + path.name:
                    self.evaluations[result["candidate"]] = result
            except (OSError, ValueError):
                continue  # A running evaluation may not have published yet.
        checkpoints = directory / "openevolve" / "checkpoints"
        if not checkpoints.is_dir() or checkpoints.is_symlink():
            return
        for checkpoint in sorted(islice(checkpoints.iterdir(), 128), key=lambda p: p.name):
            if not re.fullmatch(r"checkpoint_[0-9]+", checkpoint.name) or checkpoint.is_symlink():
                continue
            programs = checkpoint / "programs"
            if not programs.is_dir() or programs.is_symlink():
                continue
            for path in sorted(islice(programs.iterdir(), 512)):
                if path.suffix != ".json":
                    continue
                try:
                    record = read_json(path, 1048576)
                    if not isinstance(record, dict):
                        continue
                    program_id = str(uuid.UUID(record["id"]))
                    generation = record["generation"]
                    if type(generation) is not int or not 0 <= generation <= 2**53 - 1:
                        continue
                    code = record["code"]
                    if not isinstance(code, str) or len(code.encode("utf-8")) > 65536:
                        continue
                    artifacts = record.get("artifacts_json")
                    if not isinstance(artifacts, str) or len(artifacts) > 65536:
                        continue
                    artifacts = json.loads(artifacts)
                    if not isinstance(artifacts, dict):
                        continue
                    candidate = artifacts.get("candidate_id")
                    if not isinstance(candidate, str):
                        continue
                    evaluated = self.evaluations.get(candidate)
                    if not evaluated or evaluated.get("source_sha256") != hashlib.sha256(code.encode("utf-8")).hexdigest():
                        continue
                    parent = record.get("parent_id")
                    if parent is not None:
                        parent = str(uuid.UUID(parent))
                    self.programs[program_id] = {"candidate": candidate, "generation": generation, "parent_id": parent}
                except (OSError, ValueError, TypeError, KeyError):
                    continue  # OpenEvolve writes checkpoint files incrementally.
        observed = set()
        # An island migration may copy one evaluation into multiple program IDs.
        # Publish the earliest recorded individual once, without inventing a variation.
        for program_id, record in sorted(self.programs.items(), key=lambda pair: (pair[1]["generation"], pair[0])):
            parent = self.programs.get(record["parent_id"], {}).get("candidate")
            candidate = record["candidate"]
            if parent == candidate:
                continue  # Migration copies are not new evaluated variations.
            if candidate in observed:
                continue
            observed.add(candidate)
            fields = {"candidate": candidate, "generation": record["generation"]}
            if parent is not None:
                fields["parent"] = parent
            signature = (program_id, parent, record["generation"])
            if self.published.get(candidate) == signature:
                continue
            self.bridge.event("edit", "Imported recorded OpenEvolve parent/generation; optimizer program " + program_id,
                              stage="lineage", **fields)
            self.published[candidate] = signature

    def selected(self, source=None):
        """Map the actual selected optimizer record to its own measured attempt."""
        record = read_json(self.bridge.directory / "selected.json", 16384)
        if not isinstance(record, dict) or not isinstance(record.get("id"), str):
            raise ValueError("optimizer selection needs a recorded program ID")
        observed = self.programs.get(record.get("id"))
        if observed and source is not None:
            path = Path(source)
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
                raise ValueError("invalid selected source")
            with path.open("rb") as selected_file:
                code = selected_file.read(65537)
            if hashlib.sha256(code).hexdigest() != self.evaluations[observed["candidate"]]["source_sha256"]:
                raise ValueError("selected source does not match its recorded optimizer evaluation")
        return observed["candidate"] if observed else None
