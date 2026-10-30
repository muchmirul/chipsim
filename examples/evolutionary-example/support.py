"""Bounded local data helpers; importing these never starts a tool or provider."""
import json
from pathlib import Path


class SearchDeadline(KeyboardInterrupt):
    """The supervisor's overall budget expired, including manual-queue waits."""


def read_json(path, limit=2 * 1024 * 1024):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError("expected bounded regular JSON file: " + str(path))
    with path.open("rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError("JSON file grew beyond its byte limit")
    return json.loads(data.decode("utf-8"))


def write_json(path, value, *, exclusive=False):
    with Path(path).open("x" if exclusive else "w", encoding="utf-8") as output:
        json.dump(value, output, indent=2, allow_nan=False)
        output.write("\n")
