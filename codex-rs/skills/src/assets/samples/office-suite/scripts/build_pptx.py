#!/usr/bin/env python3
"""Build a .pptx deck from a JSON spec.

Usage:
    python build_pptx.py deck.json --out deck.pptx

See references/pptx-spec.md for the full layout reference.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from officelib import env  # noqa: E402

env.reexec_in_environment()

from pptx import Presentation  # noqa: E402
from pptx.util import Inches  # noqa: E402

from officelib import pptxslides, spec as specmod  # noqa: E402
from officelib.pptxlayout import Theme  # noqa: E402

ASPECTS = {
    "16:9": (13.333, 7.5),
    "16:10": (12.0, 7.5),
    "4:3": (10.0, 7.5),
}


def build(spec: dict, out_path: Path) -> Path:
    template = spec.get("template")
    presentation = Presentation(str(Path(template).expanduser())) if template else Presentation()

    if not template:
        aspect = spec.get("aspect", "16:9")
        if aspect not in ASPECTS:
            raise specmod.SpecError(f"unknown aspect `{aspect}`; use one of {', '.join(ASPECTS)}")
        width, height = ASPECTS[aspect]
        presentation.slide_width = Inches(width)
        presentation.slide_height = Inches(height)

    theme = Theme.from_spec(spec.get("theme"))
    slides = spec.get("slides")
    if not isinstance(slides, list) or not slides:
        raise specmod.SpecError("`slides` must be a non-empty list")

    for index, block in enumerate(slides):
        if not isinstance(block, dict):
            raise specmod.SpecError(f"slides[{index}] must be an object")
        try:
            pptxslides.render_slide(presentation, theme, block)
        except specmod.SpecError:
            raise
        except Exception as error:  # noqa: BLE001 - surface the failing slide
            raise specmod.SpecError(
                f"slides[{index}] (layout={block.get('layout')}) failed: {error}"
            ) from error

    presentation.save(str(out_path))
    return out_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build a .pptx deck from a JSON spec")
    parser.add_argument("spec", nargs="?", default="-", help="spec path, or - for stdin")
    parser.add_argument("--out", dest="out", default=None, help="output .pptx path")
    args = parser.parse_args(argv)

    try:
        spec = specmod.load_spec(args.spec)
        out_path = specmod.resolve_output(spec, args.out, ".pptx")
        build(spec, out_path)
    except specmod.SpecError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    print(out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
