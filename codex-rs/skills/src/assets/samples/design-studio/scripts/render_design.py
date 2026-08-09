#!/usr/bin/env python3
"""Render an HTML design artifact to PNG and/or PDF with headless Chromium.

This is the design scene's evidence loop: build an HTML artifact, render it,
then look at the rendered image before claiming the design is done.

Usage:
    python render_design.py artifact.html --png out/desktop.png --width 1440
    python render_design.py artifact.html --png out/mobile.png --width 390 --height 844
    python render_design.py deck.html --pdf out/deck.pdf --pdf-landscape
    python render_design.py artifact.html --responsive out/shots
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from designlib import chrome, measure  # noqa: E402

BREAKPOINTS = {
    "mobile": (390, 844),
    "tablet": (834, 1112),
    "desktop": (1440, 900),
    "wide": (1920, 1080),
}
RENDER_TIMEOUT_SECONDS = 120


def _file_url(path: Path) -> str:
    return path.resolve().as_uri()


def _run_chrome(binary: Path, args: list[str]) -> None:
    with tempfile.TemporaryDirectory(prefix="crewon-design-") as profile:
        command = [str(binary), *chrome.base_flags(binary, Path(profile)), *args]
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=RENDER_TIMEOUT_SECONDS,
        )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()[-1500:]
        raise RuntimeError(f"chrome exited with {completed.returncode}:\n{detail}")


def screenshot(
    binary: Path,
    source: Path,
    out: Path,
    *,
    width: int,
    height: int | None,
    scale: int,
    delay_ms: int,
) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    if height is None:
        # --screenshot captures exactly the window size, so a full-page capture
        # needs the measured document height first.
        height = measure.measure_height(binary, source, width=width) or 1200
    args = [
        f"--screenshot={out}",
        f"--window-size={width},{height}",
        f"--force-device-scale-factor={scale}",
        f"--virtual-time-budget={max(delay_ms, 400)}",
        "--allow-file-access-from-files",
        _file_url(source),
    ]
    _run_chrome(binary, args)
    if not out.is_file() or out.stat().st_size == 0:
        raise RuntimeError(f"chrome produced no screenshot at {out}")
    return out


def print_pdf(
    binary: Path,
    source: Path,
    out: Path,
    *,
    landscape: bool,
    delay_ms: int,
) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    args = [
        f"--print-to-pdf={out}",
        "--no-pdf-header-footer",
        f"--virtual-time-budget={max(delay_ms, 400)}",
        "--allow-file-access-from-files",
    ]
    if landscape:
        # Chrome has no landscape switch for --print-to-pdf; the artifact must
        # declare `@page { size: landscape }` in CSS. Warn instead of silently
        # producing portrait output.
        print(
            "note: pass landscape via CSS `@page { size: A4 landscape; }` in the artifact",
            file=sys.stderr,
        )
    args.append(_file_url(source))
    _run_chrome(binary, args)
    if not out.is_file() or out.stat().st_size == 0:
        raise RuntimeError(f"chrome produced no pdf at {out}")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render an HTML artifact via headless Chromium")
    parser.add_argument("source", help="HTML file to render")
    parser.add_argument("--png", default=None, help="PNG output path")
    parser.add_argument("--pdf", default=None, help="PDF output path")
    parser.add_argument(
        "--responsive",
        default=None,
        help="directory: render mobile/tablet/desktop/wide PNGs in one pass",
    )
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument(
        "--height",
        type=int,
        default=None,
        help="viewport height; omit for a tall full-page capture",
    )
    parser.add_argument("--scale", type=int, default=2, help="device scale factor (default 2)")
    parser.add_argument("--delay-ms", type=int, default=800, help="virtual time budget before capture")
    parser.add_argument("--pdf-landscape", action="store_true")
    args = parser.parse_args(argv)

    source = Path(args.source).expanduser()
    if not source.is_file():
        print(f"error: html file not found: {source}", file=sys.stderr)
        return 2

    try:
        binary = chrome.find_chrome()
    except chrome.ChromeNotFound as error:
        print(f"error: {error}", file=sys.stderr)
        return 3

    produced: list[Path] = []
    try:
        if args.responsive:
            root = Path(args.responsive).expanduser()
            for name, (width, height) in BREAKPOINTS.items():
                produced.append(
                    screenshot(
                        binary,
                        source,
                        root / f"{source.stem}-{name}.png",
                        width=width,
                        height=height,
                        scale=1,
                        delay_ms=args.delay_ms,
                    )
                )
        if args.png:
            produced.append(
                screenshot(
                    binary,
                    source,
                    Path(args.png).expanduser(),
                    width=args.width,
                    height=args.height,
                    scale=args.scale,
                    delay_ms=args.delay_ms,
                )
            )
        if args.pdf:
            produced.append(
                print_pdf(
                    binary,
                    source,
                    Path(args.pdf).expanduser(),
                    landscape=args.pdf_landscape,
                    delay_ms=args.delay_ms,
                )
            )
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"error: {error}", file=sys.stderr)
        return 4

    if not produced:
        print("error: nothing to do; pass --png, --pdf or --responsive", file=sys.stderr)
        return 2

    print(f"chrome: {binary}")
    for path in produced:
        print(f"{path}  ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
