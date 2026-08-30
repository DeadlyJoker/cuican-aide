#!/usr/bin/env python3
"""Audit an HTML design artifact against the design-studio quality bar.

Runs entirely on the rendered DOM (via headless Chromium ``--dump-dom``) plus
the computed styles of visible text nodes, so the checks reflect what a user
would actually see rather than what the source markup claims.

Checks:
  * text/background contrast against WCAG 2.1 AA
  * images without alt text, icon-only buttons without an accessible name
  * form inputs without an associated label
  * heading order jumps (h1 -> h3)
  * viewport meta, lang attribute
  * horizontal overflow at the audited width
  * "AI slop" markers: emoji-as-icon, unicode box drawing, placeholder copy

Usage:
    python audit_design.py artifact.html --width 1440
    python audit_design.py artifact.html --width 390 --json report.json
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from designlib import chrome  # noqa: E402
from designlib.audit_probe import PROBE_TEMPLATE  # noqa: E402

RESULT = re.compile(r"CREWON_AUDIT_BEGIN(.*?)CREWON_AUDIT_END", re.DOTALL)
AUDIT_TIMEOUT_SECONDS = 90


def collect(binary: Path, source: Path, *, width: int, height: int, settle_ms: int) -> dict:
    harness = PROBE_TEMPLATE.format(
        url=source.resolve().as_uri(),
        width=width,
        height=height,
        settle_ms=settle_ms,
    )
    with tempfile.TemporaryDirectory(prefix="crewon-audit-") as workdir:
        harness_path = Path(workdir) / "audit.html"
        harness_path.write_text(harness, encoding="utf-8")
        command = [
            str(binary),
            *chrome.base_flags(binary, Path(workdir) / "profile"),
            "--allow-file-access-from-files",
            f"--window-size={width},{height}",
            f"--virtual-time-budget={settle_ms + 2500}",
            "--dump-dom",
            harness_path.as_uri(),
        ]
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=AUDIT_TIMEOUT_SECONDS,
        )

    match = RESULT.search(completed.stdout or "")
    if not match:
        detail = (completed.stderr or "").strip()[-800:]
        raise RuntimeError(f"probe produced no result. chrome stderr:\n{detail}")
    payload = match.group(1)
    # --dump-dom serializes the JSON inside a text node, so entities come back escaped.
    payload = payload.replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    return json.loads(payload)


def flatten_layers(layers: list[str]) -> tuple[int, int, int] | None:
    """Composite a nearest-first background stack into one opaque color.

    Returns None when the stack is unusable (empty, or backed by an image whose
    pixels the probe cannot sample), so callers skip rather than guess.
    """

    from designlib import contrast

    if not layers or "IMAGE" in layers:
        return None
    parsed = [contrast.parse_color_alpha(layer) for layer in layers]
    if any(layer is None for layer in parsed):
        return None
    base = parsed[-1][0]  # type: ignore[index]
    for layer in reversed(parsed[:-1]):
        base = contrast.composite(layer, base)  # type: ignore[arg-type]
    return base


def evaluate(data: dict, *, min_ratio: float) -> tuple[list[dict], list[dict]]:
    from designlib import contrast

    failures: list[dict] = []
    warnings: list[dict] = []

    for entry in data.get("textNodes", []):
        background = flatten_layers(entry.get("backgroundLayers", []))
        if background is None:
            continue
        foreground_layer = contrast.parse_color_alpha(entry.get("color", ""))
        if not foreground_layer:
            continue
        foreground = contrast.composite(foreground_layer, background)
        ratio = contrast.contrast_ratio(foreground, background)
        size = float(entry.get("fontSize", 16))
        weight = int(entry.get("fontWeight", 400) or 400)
        large = size >= 24 or (size >= 18.66 and weight >= 700)
        level = contrast.wcag_level(ratio, large_text=large)
        if level == "FAIL" and ratio < min_ratio:
            failures.append(
                {
                    "check": "contrast",
                    "ratio": round(ratio, 2),
                    "required": 3.0 if large else 4.5,
                    "selector": entry.get("selector"),
                    "text": entry.get("text"),
                }
            )

    for issue in data.get("issues", []):
        bucket = failures if issue.get("severity") == "error" else warnings
        bucket.append(issue)

    return failures, warnings


def render_report(source: Path, width: int, data: dict, failures: list[dict], warnings: list[dict]) -> str:
    lines = [
        f"artifact: {source}",
        f"width: {width}px  documentHeight: {data.get('documentHeight')}px",
        f"text nodes audited: {len(data.get('textNodes', []))}",
    ]
    if data.get("horizontalOverflow"):
        lines.append(f"horizontal overflow: {data['horizontalOverflow']}px beyond viewport")
    for warning in warnings:
        lines.append(f"warn [{warning.get('check')}]: {warning.get('detail')} {warning.get('selector', '')}".rstrip())
    for failure in failures:
        if failure.get("check") == "contrast":
            lines.append(
                f"FAIL [contrast]: {failure['ratio']}:1 (needs {failure['required']}:1) "
                f"at {failure['selector']} — {failure['text']!r}"
            )
        else:
            lines.append(
                f"FAIL [{failure.get('check')}]: {failure.get('detail')} {failure.get('selector', '')}".rstrip()
            )
    lines.append(f"result: {'FAIL' if failures else 'PASS'} ({len(failures)} errors, {len(warnings)} warnings)")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Audit an HTML design artifact")
    parser.add_argument("source")
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--settle-ms", type=int, default=600)
    parser.add_argument("--min-ratio", type=float, default=4.5)
    parser.add_argument("--json", dest="json_out", default=None, help="write the raw report as JSON")
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

    try:
        data = collect(
            binary, source, width=args.width, height=args.height, settle_ms=args.settle_ms
        )
    except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 4

    failures, warnings = evaluate(data, min_ratio=args.min_ratio)
    print(render_report(source, args.width, data, failures, warnings))

    if args.json_out:
        out = Path(args.json_out).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {"raw": data, "failures": failures, "warnings": warnings},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"json: {out}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
