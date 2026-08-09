"""Bootstrap an isolated Python environment for the office-suite skill.

The skill must work on a clean machine without touching the user's global
interpreter, so dependencies are installed into a dedicated virtualenv under
``$CODEX_HOME/skills/.venvs/office-suite``.

``uv`` is preferred because it is fast and already required by other skills;
``python -m venv`` + ``pip`` is the fallback.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

REQUIREMENTS: tuple[str, ...] = (
    "python-docx==1.2.0",
    "python-pptx==1.0.2",
    "openpyxl==3.1.5",
    "pypdf==6.1.1",
    "pillow==11.3.0",
    "lxml==6.0.2",
)

_STAMP_NAME = ".office-suite-requirements"


def codex_home() -> Path:
    raw = os.environ.get("CODEX_HOME")
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".codex"


def venv_dir() -> Path:
    override = os.environ.get("CREWON_OFFICE_SUITE_VENV")
    if override:
        return Path(override).expanduser()
    return codex_home() / "skills" / ".venvs" / "office-suite"


def venv_python(venv: Path) -> Path:
    if os.name == "nt":
        return venv / "Scripts" / "python.exe"
    return venv / "bin" / "python"


def _stamp_matches(venv: Path) -> bool:
    stamp = venv / _STAMP_NAME
    if not stamp.is_file():
        return False
    return stamp.read_text(encoding="utf-8").strip() == "\n".join(REQUIREMENTS)


def _write_stamp(venv: Path) -> None:
    (venv / _STAMP_NAME).write_text("\n".join(REQUIREMENTS) + "\n", encoding="utf-8")


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=sys.stderr, stderr=sys.stderr)


def ensure_environment() -> Path:
    """Return a Python executable that can import every office dependency."""

    venv = venv_dir()
    python = venv_python(venv)
    if python.is_file() and _stamp_matches(venv):
        return python

    uv = shutil.which("uv")
    if not python.is_file():
        if uv:
            _run([uv, "venv", str(venv)])
        else:
            _run([sys.executable, "-m", "venv", str(venv)])

    if uv:
        _run([uv, "pip", "install", "--python", str(python), *REQUIREMENTS])
    else:
        _run([str(python), "-m", "pip", "install", "--upgrade", "pip"])
        _run([str(python), "-m", "pip", "install", *REQUIREMENTS])

    _write_stamp(venv)
    return python


def reexec_in_environment() -> None:
    """Re-run the current script inside the managed environment when needed."""

    if os.environ.get("CREWON_OFFICE_SUITE_BOOTSTRAPPED") == "1":
        return
    try:
        import docx  # noqa: F401
        import openpyxl  # noqa: F401
        import pptx  # noqa: F401

        return
    except ModuleNotFoundError:
        pass

    python = ensure_environment()
    env = dict(os.environ, CREWON_OFFICE_SUITE_BOOTSTRAPPED="1")
    completed = subprocess.run([str(python), *sys.argv], env=env, check=False)
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    print(ensure_environment())
