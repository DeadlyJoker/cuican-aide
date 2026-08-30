"""Measure the rendered height of an HTML artifact at a given viewport width.

``chrome-headless-shell --screenshot`` always captures exactly the window size,
so a full-page capture needs the document height up front. Instead of adding a
CDP client, the page is loaded inside a fixed-width iframe in a tiny harness and
the measured height is read back from ``document.title`` via ``--dump-dom``.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path

from . import chrome

HARNESS = """<!doctype html><meta charset="utf-8"><title>CREWON_H=pending</title>
<style>html,body{{margin:0;padding:0}}iframe{{border:0;display:block}}</style>
<iframe id="frame" src="{url}" style="width:{width}px;height:{probe_height}px"></iframe>
<script>
function report() {{
  try {{
    var doc = document.getElementById('frame').contentDocument;
    var body = doc.body;
    var root = doc.documentElement;
    var height = Math.max(
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    );
    document.title = 'CREWON_H=' + Math.ceil(height);
  }} catch (error) {{
    document.title = 'CREWON_H=error';
  }}
}}
window.addEventListener('load', function () {{ setTimeout(report, {settle_ms}); }});
</script>
"""

TITLE = re.compile(r"CREWON_H=(\d+)")
MAX_HEIGHT = 20000
MEASURE_TIMEOUT_SECONDS = 60


def measure_height(
    binary: Path,
    source: Path,
    *,
    width: int,
    # A short probe viewport keeps the iframe from inflating the measured height
    # of pages that are shorter than the viewport (e.g. `body { height: 100% }`).
    probe_height: int = 64,
    settle_ms: int = 350,
    budget_ms: int = 2500,
) -> int | None:
    """Return the document height in CSS pixels, or None when measuring fails."""

    harness_html = HARNESS.format(
        url=source.resolve().as_uri(),
        width=width,
        probe_height=probe_height,
        settle_ms=settle_ms,
    )
    with tempfile.TemporaryDirectory(prefix="crewon-measure-") as workdir:
        harness_path = Path(workdir) / "harness.html"
        harness_path.write_text(harness_html, encoding="utf-8")
        profile = Path(workdir) / "profile"
        command = [
            str(binary),
            *chrome.base_flags(binary, profile),
            "--allow-file-access-from-files",
            f"--virtual-time-budget={budget_ms}",
            "--dump-dom",
            harness_path.as_uri(),
        ]
        try:
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=MEASURE_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return None

    match = TITLE.search(completed.stdout or "")
    if not match:
        return None
    height = int(match.group(1))
    if height <= 0:
        return None
    return min(height, MAX_HEIGHT)
