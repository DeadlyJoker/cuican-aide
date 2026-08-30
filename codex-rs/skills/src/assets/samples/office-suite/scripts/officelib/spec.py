"""Shared spec loading helpers for the office-suite builders.

Every builder consumes the same shape: a JSON document with a ``blocks`` list
(or ``sheets`` / ``slides`` for the spreadsheet and deck builders). Keeping the
loader in one place means the builders never re-implement argument parsing or
error reporting.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


class SpecError(RuntimeError):
    """Raised when the incoming spec cannot be used to build a document."""


def load_spec(path: str | None) -> dict[str, Any]:
    """Load a spec from a file path, or from stdin when path is ``-``/None."""

    if path in (None, "-"):
        raw = sys.stdin.read()
    else:
        spec_path = Path(path).expanduser()
        if not spec_path.is_file():
            raise SpecError(f"spec file not found: {spec_path}")
        raw = spec_path.read_text(encoding="utf-8")

    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SpecError(f"spec is not valid JSON: {error}") from error

    if not isinstance(spec, dict):
        raise SpecError("spec root must be a JSON object")
    return spec


def require(spec: dict[str, Any], key: str) -> Any:
    if key not in spec:
        raise SpecError(f"spec is missing required key: {key}")
    return spec[key]


def blocks_of(spec: dict[str, Any]) -> list[dict[str, Any]]:
    blocks = spec.get("blocks", [])
    if not isinstance(blocks, list):
        raise SpecError("`blocks` must be a list")
    for index, block in enumerate(blocks):
        if not isinstance(block, dict):
            raise SpecError(f"blocks[{index}] must be an object")
        if "type" not in block:
            raise SpecError(f"blocks[{index}] is missing `type`")
    return blocks


def resolve_output(spec: dict[str, Any], cli_output: str | None, suffix: str) -> Path:
    target = cli_output or spec.get("output")
    if not target:
        raise SpecError("no output path given (pass --out or set `output` in the spec)")
    path = Path(target).expanduser()
    if path.suffix.lower() != suffix:
        raise SpecError(f"output path must end with {suffix}: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path
