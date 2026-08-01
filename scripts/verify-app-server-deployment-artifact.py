#!/usr/bin/env python3

"""Verify an immutable app-server binary against a deployment SHA allowlist.

This is an offline packaging verifier, not a production launch primitive. It
intentionally does not inspect a running process, listener, version string, or
marker file, and it does not launch the artifact. A production launcher must
verify and execute the same immutable object so that a path cannot be replaced
between verification and exec. Until that launcher exists, this script must stay
disconnected from production startup and rollback policy.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from typing import Any


CONTROL_FILE_LIMIT = 64 * 1024
ARTIFACT_SIZE_LIMIT = 2 * 1024 * 1024 * 1024
ALLOWLIST_ENTRY_LIMIT = 256
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
GENERATION_GUARDS = {
    "legacyFence": "LegacyExclusive",
    "leaseAwareCutover": "LeaseAwareShared",
}


class VerificationError(Exception):
    pass


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def require_absolute_path(value: str, label: str) -> Path:
    if not value or len(os.fsencode(value)) > 4096:
        raise VerificationError(f"{label} path is empty or too long")
    path = Path(value)
    if not path.is_absolute():
        raise VerificationError(f"{label} path must be absolute")
    return path


def open_immutable_regular(path: Path, label: str) -> int:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise VerificationError(f"cannot open {label}: {error.strerror}") from error

    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode):
        os.close(descriptor)
        raise VerificationError(f"{label} must be a regular file")
    if metadata.st_nlink != 1:
        os.close(descriptor)
        raise VerificationError(f"{label} must have exactly one hard link")
    if metadata.st_mode & 0o222:
        os.close(descriptor)
        raise VerificationError(f"{label} must be immutable (no write bits)")
    return descriptor


def stable_identity(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def assert_stable_path(
    path: Path, descriptor: int, before: os.stat_result, label: str
) -> None:
    after = os.fstat(descriptor)
    try:
        path_after = os.stat(path, follow_symlinks=False)
    except OSError as error:
        raise VerificationError(f"{label} disappeared during verification") from error
    if stable_identity(before) != stable_identity(after):
        raise VerificationError(f"{label} changed while it was being read")
    if stable_identity(after) != stable_identity(path_after):
        raise VerificationError(f"{label} path was replaced during verification")


def read_control_json(path: Path, label: str) -> dict[str, Any]:
    descriptor = open_immutable_regular(path, label)
    try:
        before = os.fstat(descriptor)
        if before.st_size <= 0 or before.st_size > CONTROL_FILE_LIMIT:
            raise VerificationError(
                f"{label} size must be between 1 and {CONTROL_FILE_LIMIT} bytes"
            )
        chunks: list[bytes] = []
        remaining = CONTROL_FILE_LIMIT + 1
        while remaining > 0:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        if len(payload) != before.st_size:
            raise VerificationError(f"{label} was not read completely")
        assert_stable_path(path, descriptor, before, label)
    finally:
        os.close(descriptor)

    try:
        decoded = payload.decode("utf-8")
        value = json.loads(decoded, object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError(f"{label} is not strict UTF-8 JSON: {error}") from error
    if not isinstance(value, dict):
        raise VerificationError(f"{label} root must be an object")
    return value


def require_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        raise VerificationError(
            f"{label} keys must be {sorted(expected)}, got {sorted(actual)}"
        )


def require_positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise VerificationError(f"{label} must be a positive integer")
    if value > ARTIFACT_SIZE_LIMIT:
        raise VerificationError(f"{label} exceeds {ARTIFACT_SIZE_LIMIT} bytes")
    return value


def require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
        raise VerificationError(f"{label} must be 64 lowercase hexadecimal characters")
    return value


def require_generation(value: Any, label: str) -> str:
    if not isinstance(value, str) or value not in GENERATION_GUARDS:
        raise VerificationError(f"{label} must be one of {sorted(GENERATION_GUARDS)}")
    return value


def parse_artifact_record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise VerificationError(f"{label} must be an object")
    require_exact_keys(
        value,
        {"artifactKind", "generation", "guardMode", "sha256", "sizeBytes"},
        label,
    )
    if value["artifactKind"] != "crewon-app-server":
        raise VerificationError(f"{label}.artifactKind must be crewon-app-server")
    generation = require_generation(value["generation"], f"{label}.generation")
    expected_guard = GENERATION_GUARDS[generation]
    if value["guardMode"] != expected_guard:
        raise VerificationError(
            f"{label}.guardMode must be {expected_guard} for {generation}"
        )
    return {
        "artifactKind": "crewon-app-server",
        "generation": generation,
        "guardMode": expected_guard,
        "sha256": require_sha256(value["sha256"], f"{label}.sha256"),
        "sizeBytes": require_positive_int(value["sizeBytes"], f"{label}.sizeBytes"),
    }


def parse_manifest(path: Path) -> dict[str, Any]:
    value = read_control_json(path, "artifact manifest")
    require_exact_keys(value, {"schemaVersion", "artifact"}, "artifact manifest")
    if isinstance(value["schemaVersion"], bool) or value["schemaVersion"] != 1:
        raise VerificationError("artifact manifest schemaVersion must be 1")
    return parse_artifact_record(value["artifact"], "artifact manifest.artifact")


def parse_allowlist(path: Path) -> list[dict[str, Any]]:
    value = read_control_json(path, "artifact allowlist")
    require_exact_keys(
        value, {"schemaVersion", "allowedArtifacts"}, "artifact allowlist"
    )
    if isinstance(value["schemaVersion"], bool) or value["schemaVersion"] != 1:
        raise VerificationError("artifact allowlist schemaVersion must be 1")
    entries = value["allowedArtifacts"]
    if not isinstance(entries, list) or not entries:
        raise VerificationError("artifact allowlist.allowedArtifacts must be non-empty")
    if len(entries) > ALLOWLIST_ENTRY_LIMIT:
        raise VerificationError(
            f"artifact allowlist exceeds {ALLOWLIST_ENTRY_LIMIT} entries"
        )
    parsed = [
        parse_artifact_record(entry, f"artifact allowlist.allowedArtifacts[{index}]")
        for index, entry in enumerate(entries)
    ]
    identities = [(entry["generation"], entry["sha256"]) for entry in parsed]
    if len(identities) != len(set(identities)):
        raise VerificationError("artifact allowlist contains duplicate identities")
    return parsed


def hash_artifact(path: Path) -> tuple[str, int]:
    descriptor = open_immutable_regular(path, "app-server artifact")
    try:
        before = os.fstat(descriptor)
        if before.st_size <= 0 or before.st_size > ARTIFACT_SIZE_LIMIT:
            raise VerificationError(
                f"app-server artifact size must be between 1 and {ARTIFACT_SIZE_LIMIT} bytes"
            )
        if before.st_mode & 0o111 == 0:
            raise VerificationError("app-server artifact must be executable")
        digest = hashlib.sha256()
        while chunk := os.read(descriptor, 1024 * 1024):
            digest.update(chunk)
        assert_stable_path(path, descriptor, before, "app-server artifact")
        return digest.hexdigest(), before.st_size
    finally:
        os.close(descriptor)


def verify(
    artifact_path: Path,
    manifest_path: Path,
    allowlist_path: Path,
    required_generation: str,
) -> dict[str, Any]:
    manifest = parse_manifest(manifest_path)
    allowed = parse_allowlist(allowlist_path)
    if manifest["generation"] != required_generation:
        raise VerificationError(
            "artifact generation does not match the launcher's required generation"
        )
    digest, size = hash_artifact(artifact_path)
    if digest != manifest["sha256"] or size != manifest["sizeBytes"]:
        raise VerificationError("artifact bytes do not match the immutable manifest")
    if manifest not in allowed:
        raise VerificationError("artifact SHA/generation is not deployment-allowed")
    return {
        "verified": True,
        "artifactPath": str(artifact_path),
        "sha256": digest,
        "sizeBytes": size,
        "generation": manifest["generation"],
        "guardMode": manifest["guardMode"],
        "productionWiring": "notConnected",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Offline-only verification of crewon-app-server bytes against a strict "
            "manifest and deployment SHA allowlist. This verifier does not exec the "
            "artifact and must not be wired directly into production startup."
        )
    )
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--allowlist", required=True)
    parser.add_argument(
        "--required-generation",
        required=True,
        choices=sorted(GENERATION_GUARDS),
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = verify(
            require_absolute_path(args.artifact, "artifact"),
            require_absolute_path(args.manifest, "manifest"),
            require_absolute_path(args.allowlist, "allowlist"),
            args.required_generation,
        )
    except VerificationError as error:
        print(f"artifact verification failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
