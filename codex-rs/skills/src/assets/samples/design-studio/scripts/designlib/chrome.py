"""Locate a headless-capable Chromium binary without adding dependencies.

Search order (first hit wins):
  1. ``CREWON_CHROME`` env override
  2. Playwright's cached ``chrome-headless-shell`` / Chromium build
  3. ``chromium`` / ``chrome`` / ``google-chrome`` / ``msedge`` on PATH
  4. Well-known application bundles per platform

The headless shell is preferred over a full desktop Chrome install: a full
Chrome with an active user profile frequently stalls under ``--headless=new``
(observed on macOS), while the shell starts in well under a second.

Playwright itself is not required; only its cached binary is reused when present.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

PATH_CANDIDATES = (
    "chrome-headless-shell",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
    "microsoft-edge",
    "msedge",
)

MAC_BUNDLES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
)

LINUX_BUNDLES = (
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
)

WINDOWS_BUNDLES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
)


class ChromeNotFound(RuntimeError):
    pass


def _playwright_cache_roots() -> list[Path]:
    override = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if override:
        return [Path(override).expanduser()]
    home = Path.home()
    if sys.platform == "darwin":
        return [home / "Library" / "Caches" / "ms-playwright"]
    if sys.platform.startswith("win"):
        return [home / "AppData" / "Local" / "ms-playwright"]
    return [home / ".cache" / "ms-playwright"]


SHELL_PATTERNS = (
    "chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell",
    "chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell.exe",
    "chromium_headless_shell-*/*/headless_shell",
    "chromium_headless_shell-*/*/headless_shell.exe",
)

FULL_PATTERNS = (
    "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
    "chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chromium-*/chrome-linux*/chrome",
    "chromium-*/chrome-win*/chrome.exe",
)


def _playwright_binaries() -> list[Path]:
    """Cached Playwright binaries, headless shells first (they start fastest)."""

    found: list[Path] = []
    for pattern_group in (SHELL_PATTERNS, FULL_PATTERNS):
        for root in _playwright_cache_roots():
            if not root.is_dir():
                continue
            for pattern in pattern_group:
                found.extend(sorted(root.glob(pattern), reverse=True))
    return found


def find_chrome() -> Path:
    override = os.environ.get("CREWON_CHROME")
    if override:
        path = Path(override).expanduser()
        if path.is_file():
            return path
        raise ChromeNotFound(f"CREWON_CHROME does not point at a file: {path}")

    for candidate in _playwright_binaries():
        if candidate.is_file():
            return candidate

    for name in PATH_CANDIDATES:
        resolved = shutil.which(name)
        if resolved:
            return Path(resolved)

    bundles = MAC_BUNDLES
    if sys.platform.startswith("linux"):
        bundles = LINUX_BUNDLES
    elif sys.platform.startswith("win"):
        bundles = WINDOWS_BUNDLES
    for raw in bundles:
        path = Path(raw)
        if path.is_file():
            return path

    raise ChromeNotFound(
        "no Chromium/Chrome binary found. Install Chrome, or set CREWON_CHROME to a binary path, "
        "or run `npx playwright install chromium`."
    )


def is_headless_shell(binary: Path) -> bool:
    return "headless" in binary.name.lower()


def base_flags(binary: Path, user_data_dir: Path) -> list[str]:
    """Flags shared by screenshot and PDF runs. Headless, no network surprises."""

    flags = [] if is_headless_shell(binary) else ["--headless=new"]
    flags += [
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-dev-shm-usage",
        "--force-color-profile=srgb",
        "--font-render-hinting=none",
        f"--user-data-dir={user_data_dir}",
    ]
    return flags
