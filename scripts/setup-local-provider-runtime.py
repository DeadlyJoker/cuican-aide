#!/usr/bin/env python3

"""Create or verify the local Agent Platform Provider v3 trust harness."""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
import sys
import tempfile


BEGIN_MARKER = "# BEGIN CREWON LOCAL PROVIDER RUNTIME"
END_MARKER = "# END CREWON LOCAL PROVIDER RUNTIME"
MIN_RSA_BITS = 2048

KEYS = {
    "crewon-identity": "crewon-local-identity-v1",
    "crewon-provider": "crewon-local-provider-v1",
    "agent-platform-bootstrap": "agent-platform-local-bootstrap-v1",
    "agent-platform-session": "agent-platform-local-session-v1",
}


class HarnessError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    script_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        description="Generate or verify the local Provider v3 trust configuration.",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=script_root,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--agent-platform-root",
        type=Path,
        help="Agent Platform checkout (default: ../agent-platform).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate the generated harness without changing files.",
    )
    return parser.parse_args(argv)


def run(command: list[str], *, input_bytes: bytes | None = None) -> bytes:
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            input=input_bytes,
        )
    except FileNotFoundError as error:
        raise HarnessError(f"required command is unavailable: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", errors="replace").strip()
        raise HarnessError(
            detail or f"command failed: {shlex.join(command)}"
        ) from error
    return completed.stdout


def require_checkout(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if (
        not resolved.is_dir()
        or not (resolved / "backend" / "app" / "main.py").is_file()
    ):
        raise HarnessError(f"Agent Platform checkout is invalid: {resolved}")
    return resolved


def ensure_directory(path: Path, mode: int = 0o700) -> None:
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        raise HarnessError(f"expected a real directory: {path}")
    path.mkdir(parents=True, exist_ok=True, mode=mode)
    path.chmod(mode)


def require_regular_file(path: Path, *, mode: int | None = None) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise HarnessError(f"required file is missing: {path}") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise HarnessError(f"expected a real regular file: {path}")
    if mode is not None and stat.S_IMODE(metadata.st_mode) != mode:
        raise HarnessError(f"expected mode {mode:04o} for {path}")


def atomic_write(path: Path, content: bytes, mode: int) -> None:
    if path.parent.exists() and (path.parent.is_symlink() or not path.parent.is_dir()):
        raise HarnessError(f"expected a real parent directory: {path.parent}")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and (path.is_symlink() or not path.is_file()):
        raise HarnessError(f"refusing to replace non-regular path: {path}")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        path.chmod(mode)
    finally:
        temporary.unlink(missing_ok=True)


def rsa_public_key(private_key: Path) -> str:
    require_regular_file(private_key, mode=0o600)
    run(["openssl", "rsa", "-in", os.fspath(private_key), "-check", "-noout"])
    details = run(
        ["openssl", "rsa", "-in", os.fspath(private_key), "-text", "-noout"]
    ).decode("utf-8", errors="replace")
    match = re.search(r"Private-Key:\s*\((\d+) bit", details)
    if match is None or int(match.group(1)) < MIN_RSA_BITS:
        raise HarnessError(
            f"RSA key is smaller than {MIN_RSA_BITS} bits: {private_key}"
        )
    return run(["openssl", "pkey", "-in", os.fspath(private_key), "-pubout"]).decode(
        "ascii"
    )


def ensure_private_key(path: Path) -> None:
    if path.exists():
        if path.is_symlink() or not path.is_file():
            raise HarnessError(f"refusing to replace non-regular key path: {path}")
        path.chmod(0o600)
        rsa_public_key(path)
        return
    ensure_directory(path.parent)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        temporary.chmod(0o600)
        run(
            [
                "openssl",
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                f"rsa_keygen_bits:{MIN_RSA_BITS}",
                "-out",
                os.fspath(temporary),
            ]
        )
        temporary.chmod(0o600)
        os.replace(temporary, path)
        path.chmod(0o600)
        rsa_public_key(path)
    finally:
        temporary.unlink(missing_ok=True)


def public_keyset_content(key_id: str, public_key: str) -> bytes:
    return (json.dumps({key_id: public_key}, sort_keys=True) + "\n").encode("utf-8")


def validate_public_keyset(path: Path, key_id: str, expected_public_key: str) -> None:
    require_regular_file(path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HarnessError(f"public keyset is invalid: {path}") from error
    if payload != {key_id: expected_public_key}:
        raise HarnessError(f"public keyset does not match its private key: {path}")


def ensure_secret(path: Path) -> None:
    if path.exists():
        require_regular_file(path)
        path.chmod(0o600)
        validate_secret(path)
        return
    atomic_write(path, f"{secrets.token_hex(32)}\n".encode("ascii"), 0o600)


def validate_secret(path: Path) -> None:
    require_regular_file(path, mode=0o600)
    try:
        value = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError) as error:
        raise HarnessError(f"internal secret is unreadable: {path}") from error
    if len(value.encode("utf-8")) < 32 or value in {
        "change-me",
        "dev-internal-secret-change-in-production",
    }:
        raise HarnessError(f"internal secret is invalid: {path}")


def agent_platform_environment(runtime_root: Path) -> str:
    runtime_dir = shlex.quote(os.fspath(runtime_root.resolve()))
    template = """# Generated by scripts/setup-local-provider-runtime.py. Source this file before
# starting the local Agent Platform backend and permission service.
_crewon_provider_runtime_dir=__CREWON_PROVIDER_RUNTIME_DIR__

export INTERNAL_API_SECRET="$(cat "${_crewon_provider_runtime_dir}/internal-api-secret")"
export PERMISSION_SERVICE_URL=http://127.0.0.1:8010
export IDENTITY_SOURCE_ENABLED=true
export IDENTITY_SOURCE_SERVICE_TRUSTED_PUBLIC_KEYS_JSON="$(cat "${_crewon_provider_runtime_dir}/public/crewon-identity.json")"
export IDENTITY_SOURCE_PRINCIPAL_TRUSTED_PUBLIC_KEYS_JSON="$(cat "${_crewon_provider_runtime_dir}/public/agent-platform-bootstrap.json")"
export IDENTITY_SOURCE_ALLOWED_SERVICE_SUBJECTS_JSON='["crewon-app-server"]'
export BOOTSTRAP_PRINCIPAL_SIGNING_KEY_ID=agent-platform-local-bootstrap-v1
export BOOTSTRAP_PRINCIPAL_SIGNING_PRIVATE_KEY_PEM="$(cat "${_crewon_provider_runtime_dir}/private/agent-platform-bootstrap.pem")"
export PRINCIPAL_SESSION_SIGNING_KEY_ID=agent-platform-local-session-v1
export PRINCIPAL_SESSION_SIGNING_PRIVATE_KEY_PEM="$(cat "${_crewon_provider_runtime_dir}/private/agent-platform-session.pem")"
export PROVIDER_RUN_ENABLED=true
export PROVIDER_RUN_TRUSTED_PUBLIC_KEYS_JSON="$(cat "${_crewon_provider_runtime_dir}/public/crewon-provider.json")"
export PROVIDER_RUN_ALLOWED_SERVICE_SUBJECTS_JSON='["crewon-app-server"]'
export PROVIDER_DYNAMIC_ENABLED=true
export PROVIDER_ARTIFACT_STORE_MODE=development-local-filesystem
export PROVIDER_ARTIFACT_LOCAL_ROOT="${_crewon_provider_runtime_dir}/artifacts"
# Force the local Provider harness to use the backend-owned STDIO MCP runtime.
export MCP_SERVICE_URL=

unset _crewon_provider_runtime_dir
"""
    return template.replace("__CREWON_PROVIDER_RUNTIME_DIR__", runtime_dir)


def crewon_environment_block(runtime_root: Path) -> str:
    private_root = runtime_root / "private"
    public_root = runtime_root / "public"

    def assignment(name: str, value: str) -> str:
        return f"export {name}={shlex.quote(value)}"

    lines = [
        BEGIN_MARKER,
        "# Managed by scripts/setup-local-provider-runtime.py; rerun the harness to update.",
        assignment("CREWON_PRINCIPAL_SESSION_ENABLED", "true"),
        assignment("CREWON_IDENTITY_SOURCE_URL", "http://127.0.0.1:8000/identity/v1/"),
        assignment("CREWON_IDENTITY_SOURCE_ENDPOINT_MODE", "development-loopback"),
        assignment(
            "CREWON_IDENTITY_SOURCE_SERVICE_SIGNING_KEY_ID", KEYS["crewon-identity"]
        ),
        assignment(
            "CREWON_IDENTITY_SOURCE_SERVICE_SIGNING_PRIVATE_KEY_FILE",
            os.fspath(private_root / "crewon-identity.pem"),
        ),
        assignment(
            "CREWON_IDENTITY_SOURCE_BOOTSTRAP_TRUSTED_PUBLIC_KEYS_FILE",
            os.fspath(public_root / "agent-platform-bootstrap.json"),
        ),
        assignment(
            "CREWON_PRINCIPAL_SESSION_TRUSTED_PUBLIC_KEYS_FILE",
            os.fspath(public_root / "agent-platform-session.json"),
        ),
        assignment("CREWON_PROVIDER_AGENT_PLATFORM_ENABLED", "true"),
        assignment(
            "CREWON_PROVIDER_AGENT_PLATFORM_URL", "http://127.0.0.1:8000/provider/v3/"
        ),
        assignment(
            "CREWON_PROVIDER_AGENT_PLATFORM_ENDPOINT_MODE", "development-loopback"
        ),
        assignment(
            "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_KEY_ID", KEYS["crewon-provider"]
        ),
        assignment(
            "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_PRIVATE_KEY_FILE",
            os.fspath(private_root / "crewon-provider.pem"),
        ),
        END_MARKER,
    ]
    return "\n".join(lines)


def replace_controlled_block(existing: str, block: str) -> str:
    begin_count = existing.count(BEGIN_MARKER)
    end_count = existing.count(END_MARKER)
    if begin_count != end_count or begin_count > 1:
        raise HarnessError(".crewon/.env contains a malformed Provider runtime block")
    if begin_count == 1:
        start = existing.index(BEGIN_MARKER)
        end = existing.index(END_MARKER, start) + len(END_MARKER)
        prefix = existing[:start].rstrip("\n")
        suffix = existing[end:].lstrip("\n")
        parts = [part for part in (prefix, block, suffix.rstrip("\n")) if part]
        return "\n\n".join(parts) + "\n"
    prefix = existing.rstrip("\n")
    return f"{prefix}\n\n{block}\n" if prefix else f"{block}\n"


def validate_controlled_block(existing: str, block: str) -> None:
    if existing.count(BEGIN_MARKER) != 1 or existing.count(END_MARKER) != 1:
        raise HarnessError(
            ".crewon/.env does not contain exactly one Provider runtime block"
        )
    start = existing.index(BEGIN_MARKER)
    end = existing.index(END_MARKER, start) + len(END_MARKER)
    if existing[start:end] != block:
        raise HarnessError(".crewon/.env Provider runtime block is stale")


def expected_dev_ui_environment() -> str:
    return "VITE_CREWON_PRINCIPAL_SESSION_ENABLED=true\n"


def ensure_gitignore_entry(path: Path) -> None:
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    required = [".crewon/dev/", ".crewon/dev-ui.env"]
    missing = [entry for entry in required if entry not in existing.splitlines()]
    if not missing:
        return
    suffix = "\n" if existing and not existing.endswith("\n") else ""
    addition = "\n".join(missing) + "\n"
    atomic_write(path, f"{existing}{suffix}{addition}".encode("utf-8"), 0o644)


def validate_gitignore(path: Path) -> None:
    require_regular_file(path)
    entries = set(path.read_text(encoding="utf-8").splitlines())
    for required in (".crewon/dev/", ".crewon/dev-ui.env"):
        if required not in entries:
            raise HarnessError(f".gitignore is missing {required}")


def validate_crewon_dev_script(path: Path) -> None:
    require_regular_file(path)
    content = path.read_text(encoding="utf-8")
    if '"dev-ui.env"' not in content:
        raise HarnessError(
            "scripts/crewon-desktop-dev.mjs does not load .crewon/dev-ui.env"
        )
    if '".crewon", ".env"' in content or "agent-platform.env.sh" in content:
        raise HarnessError(
            "scripts/crewon-desktop-dev.mjs loads a server-side environment file"
        )


def generate(repo_root: Path, agent_platform_root: Path) -> None:
    require_checkout(agent_platform_root)
    runtime_root = repo_root / ".crewon" / "dev" / "provider-runtime"
    private_root = runtime_root / "private"
    public_root = runtime_root / "public"
    artifacts_root = runtime_root / "artifacts"
    for directory in (runtime_root, private_root, public_root, artifacts_root):
        ensure_directory(directory)

    for name, key_id in KEYS.items():
        private_key = private_root / f"{name}.pem"
        public_keyset = public_root / f"{name}.json"
        ensure_private_key(private_key)
        public_key = rsa_public_key(private_key)
        atomic_write(public_keyset, public_keyset_content(key_id, public_key), 0o644)

    secret_file = runtime_root / "internal-api-secret"
    ensure_secret(secret_file)
    atomic_write(
        runtime_root / "agent-platform.env.sh",
        agent_platform_environment(runtime_root).encode("utf-8"),
        0o600,
    )
    atomic_write(
        repo_root / ".crewon" / "dev-ui.env",
        expected_dev_ui_environment().encode("utf-8"),
        0o600,
    )

    crewon_env = repo_root / ".crewon" / ".env"
    existing = crewon_env.read_text(encoding="utf-8") if crewon_env.exists() else ""
    updated = replace_controlled_block(
        existing, crewon_environment_block(runtime_root.resolve())
    )
    atomic_write(crewon_env, updated.encode("utf-8"), 0o600)
    ensure_gitignore_entry(repo_root / ".gitignore")


def check(repo_root: Path, agent_platform_root: Path) -> None:
    require_checkout(agent_platform_root)
    runtime_root = repo_root / ".crewon" / "dev" / "provider-runtime"
    for directory in (
        runtime_root,
        runtime_root / "private",
        runtime_root / "public",
        runtime_root / "artifacts",
    ):
        if directory.is_symlink() or not directory.is_dir():
            raise HarnessError(f"required directory is missing or unsafe: {directory}")

    for name, key_id in KEYS.items():
        private_key = runtime_root / "private" / f"{name}.pem"
        public_key = rsa_public_key(private_key)
        validate_public_keyset(
            runtime_root / "public" / f"{name}.json", key_id, public_key
        )

    validate_secret(runtime_root / "internal-api-secret")
    agent_env = runtime_root / "agent-platform.env.sh"
    require_regular_file(agent_env, mode=0o600)
    if agent_env.read_text(encoding="utf-8") != agent_platform_environment(
        runtime_root
    ):
        raise HarnessError("agent-platform.env.sh is stale")
    if "BEGIN PRIVATE KEY" in agent_env.read_text(encoding="utf-8"):
        raise HarnessError("agent-platform.env.sh contains an expanded private key")

    dev_ui = repo_root / ".crewon" / "dev-ui.env"
    require_regular_file(dev_ui, mode=0o600)
    if dev_ui.read_text(encoding="utf-8") != expected_dev_ui_environment():
        raise HarnessError(".crewon/dev-ui.env contains unexpected values")

    crewon_env = repo_root / ".crewon" / ".env"
    require_regular_file(crewon_env, mode=0o600)
    validate_controlled_block(
        crewon_env.read_text(encoding="utf-8"),
        crewon_environment_block(runtime_root.resolve()),
    )
    validate_gitignore(repo_root / ".gitignore")
    validate_crewon_dev_script(repo_root / "scripts" / "crewon-desktop-dev.mjs")


def main(argv: list[str] | None = None) -> int:
    arguments = parse_args(sys.argv[1:] if argv is None else argv)
    repo_root = arguments.repo_root.expanduser().resolve()
    agent_platform_root = (
        arguments.agent_platform_root.expanduser().resolve()
        if arguments.agent_platform_root is not None
        else repo_root.parent / "agent-platform"
    )
    try:
        if arguments.check:
            check(repo_root, agent_platform_root)
            print(f"Local Provider runtime harness is valid: {repo_root}")
        else:
            generate(repo_root, agent_platform_root)
            print(f"Local Provider runtime harness is ready: {repo_root}")
            print(
                "Agent Platform environment: "
                f"{repo_root / '.crewon/dev/provider-runtime/agent-platform.env.sh'}"
            )
    except HarnessError as error:
        print(f"setup-local-provider-runtime: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
