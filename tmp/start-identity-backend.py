#!/usr/bin/env python3
"""Start the identity-source-enabled Agent Platform backend on a spare port.

The checkout serving :8000 lacks the /identity/v1 mount, so the CrewON principal
session cannot be established and Expert Team requests fail closed. The
3c5c346 worktree carries the full identity source implementation; run it on
:8100 against the same SQLite database so accounts and data stay identical.

The main .env holds values with spaces, so it is parsed here instead of being
sourced by a shell.
"""

import os
from pathlib import Path

MAIN_BACKEND = Path("/Users/wangqichen/projects/brilliant/agent-platform/backend")
IDENTITY_BACKEND = Path("/private/tmp/agent-platform-provider-v3-3c5c346/backend")
RUNTIME_DIR = Path(
    "/Users/wangqichen/projects/brilliant/cuican-aide/.crewon/dev/provider-runtime"
)


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key.replace("_", "").isalnum():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


environment = dict(os.environ)
environment.update(parse_env_file(MAIN_BACKEND / ".env"))
environment.update(
    {
        # Absolute path so both instances share one database file.
        "DATABASE_URL": f"sqlite+aiosqlite:///{MAIN_BACKEND / 'agent_platform.db'}",
        "INTERNAL_API_SECRET": read(RUNTIME_DIR / "internal-api-secret"),
        "PERMISSION_SERVICE_URL": "http://127.0.0.1:8010",
        "IDENTITY_SOURCE_ENABLED": "true",
        "IDENTITY_SOURCE_SERVICE_TRUSTED_PUBLIC_KEYS_JSON": read(
            RUNTIME_DIR / "public/crewon-identity.json"
        ),
        "IDENTITY_SOURCE_PRINCIPAL_TRUSTED_PUBLIC_KEYS_JSON": read(
            RUNTIME_DIR / "public/agent-platform-bootstrap.json"
        ),
        "IDENTITY_SOURCE_ALLOWED_SERVICE_SUBJECTS_JSON": '["crewon-app-server"]',
        "BOOTSTRAP_PRINCIPAL_SIGNING_KEY_ID": "agent-platform-local-bootstrap-v1",
        "BOOTSTRAP_PRINCIPAL_SIGNING_PRIVATE_KEY_PEM": read(
            RUNTIME_DIR / "private/agent-platform-bootstrap.pem"
        ),
        "PRINCIPAL_SESSION_SIGNING_KEY_ID": "agent-platform-local-session-v1",
        "PRINCIPAL_SESSION_SIGNING_PRIVATE_KEY_PEM": read(
            RUNTIME_DIR / "private/agent-platform-session.pem"
        ),
        "PROVIDER_RUN_ENABLED": "true",
        "PROVIDER_RUN_TRUSTED_PUBLIC_KEYS_JSON": read(
            RUNTIME_DIR / "public/crewon-provider.json"
        ),
        "PROVIDER_RUN_ALLOWED_SERVICE_SUBJECTS_JSON": '["crewon-app-server"]',
        "PROVIDER_DYNAMIC_ENABLED": "true",
        "PROVIDER_ARTIFACT_STORE_MODE": "development-local-filesystem",
        "PROVIDER_ARTIFACT_LOCAL_ROOT": str(RUNTIME_DIR / "artifacts"),
        "MCP_SERVICE_URL": "",
    }
)

os.chdir(IDENTITY_BACKEND)
os.execve(
    str(IDENTITY_BACKEND / ".venv/bin/python"),
    [
        str(IDENTITY_BACKEND / ".venv/bin/python"),
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "8100",
    ],
    environment,
)
