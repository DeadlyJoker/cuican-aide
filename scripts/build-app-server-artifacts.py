#!/usr/bin/env python3

"""Build and atomically package the two app-server generation artifacts."""

import argparse
import ctypes
from dataclasses import dataclass
from datetime import datetime, timezone
import errno
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
from typing import Mapping, Protocol, Sequence


ARTIFACT_NAME = "crewon-app-server"
GENERATIONS = (
    ("leaseAwareCutover", "LeaseAwareShared", ()),
    ("legacyFence", "LegacyExclusive", ("legacy-fence-artifact",)),
)
TIMEOUT_ENV_PREFIX = "CREWON_APP_SERVER_BUILD_TIMEOUT_"
DEFAULT_TIMEOUT_SECONDS = {
    "cargo": 1800.0,
    "probe": 180.0,
    "verifier": 60.0,
    "metadata": 30.0,
    "default": 60.0,
}
DEFAULT_TERMINATE_GRACE_SECONDS = 5.0


class BuildError(Exception):
    pass


class Runner(Protocol):
    def run(
        self,
        command: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str] | None = None,
    ) -> str: ...


class SubprocessRunner:
    @staticmethod
    def _command_category(command: Sequence[str]) -> str:
        if tuple(command[:2]) == ("cargo", "build"):
            return "cargo"
        if len(command) > 1 and command[1].endswith("probe-app-server-generation.py"):
            return "probe"
        if len(command) > 1 and command[1].endswith(
            "verify-app-server-deployment-artifact.py"
        ):
            return "verifier"
        if command and command[0] in {"git", "rustc"}:
            return "metadata"
        return "default"

    @staticmethod
    def _positive_timeout(environment_name: str, default: float) -> float:
        value = os.environ.get(environment_name)
        if value is None:
            return default
        try:
            timeout = float(value)
        except ValueError as error:
            raise BuildError(f"{environment_name} must be a positive number") from error
        if timeout <= 0:
            raise BuildError(f"{environment_name} must be a positive number")
        return timeout

    def _timeout_seconds(self, command: Sequence[str]) -> float:
        category = self._command_category(command)
        return self._positive_timeout(
            f"{TIMEOUT_ENV_PREFIX}{category.upper()}_SECONDS",
            DEFAULT_TIMEOUT_SECONDS[category],
        )

    @staticmethod
    def _terminate_process_group(
        process: subprocess.Popen[str], terminate_grace_seconds: float
    ) -> tuple[str, str]:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            return process.communicate(timeout=terminate_grace_seconds)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stdout, stderr = process.communicate()
            process.wait()
            return stdout, stderr

    def run(
        self,
        command: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str] | None = None,
    ) -> str:
        timeout_seconds = self._timeout_seconds(command)
        terminate_grace_seconds = self._positive_timeout(
            f"{TIMEOUT_ENV_PREFIX}TERMINATE_GRACE_SECONDS",
            DEFAULT_TERMINATE_GRACE_SECONDS,
        )
        process = subprocess.Popen(
            list(command),
            cwd=cwd,
            env=dict(env) if env is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            stdout, stderr = self._terminate_process_group(
                process, terminate_grace_seconds
            )
            detail = stderr.strip() or stdout.strip()
            raise BuildError(
                f"command timed out after {timeout_seconds:g}s: {' '.join(command)}"
                + (f"\n{detail}" if detail else "")
            )
        if process.returncode != 0:
            detail = stderr.strip() or stdout.strip()
            raise BuildError(
                f"command failed ({process.returncode}): {' '.join(command)}"
                + (f"\n{detail}" if detail else "")
            )
        return stdout


@dataclass(frozen=True)
class BuildConfig:
    repo_root: Path
    output_dir: Path
    target: str | None
    allow_dirty: bool
    dry_run: bool
    skip_generation_probe: bool


@dataclass(frozen=True)
class GitSnapshot:
    commit: str
    status: str

    @property
    def dirty(self) -> bool:
        return bool(self.status.strip())

    @property
    def status_sha256(self) -> str:
        return hashlib.sha256(self.status.encode()).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cargo_command(target: str, features: Sequence[str]) -> list[str]:
    command = [
        "cargo",
        "build",
        "--manifest-path",
        "Cargo.toml",
        "--frozen",
        "--release",
        "--target",
        target,
        "-p",
        "crewon-app-server",
        "--bin",
        ARTIFACT_NAME,
        "--no-default-features",
    ]
    if features:
        command.extend(["--features", ",".join(features)])
    return command


def require_repo(config: BuildConfig) -> tuple[Path, Path, str]:
    repo_root = config.repo_root.resolve(strict=True)
    cargo_lock = repo_root / "codex-rs" / "Cargo.lock"
    cargo_manifest = repo_root / "codex-rs" / "Cargo.toml"
    if not cargo_lock.is_file() or not cargo_manifest.is_file():
        raise BuildError("repo root must contain codex-rs/Cargo.toml and Cargo.lock")
    return repo_root, cargo_lock, sha256_file(cargo_lock)


def capture_git_snapshot(repo_root: Path, runner: Runner) -> GitSnapshot:
    commit_before = runner.run(["git", "rev-parse", "HEAD"], cwd=repo_root).strip()
    if not commit_before:
        raise BuildError("git rev-parse HEAD returned an empty commit")
    status = runner.run(
        [
            "git",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
        cwd=repo_root,
    )
    commit_after = runner.run(["git", "rev-parse", "HEAD"], cwd=repo_root).strip()
    if commit_before != commit_after:
        raise BuildError("git HEAD changed while capturing the source snapshot")
    return GitSnapshot(commit=commit_before, status=status)


def git_metadata(repo_root: Path, runner: Runner, allow_dirty: bool) -> GitSnapshot:
    snapshot = capture_git_snapshot(repo_root, runner)
    if snapshot.dirty and not allow_dirty:
        raise BuildError("refusing to build artifacts from a dirty git tree")
    return snapshot


def require_unchanged_git_snapshot(
    repo_root: Path, runner: Runner, expected: GitSnapshot
) -> None:
    actual = capture_git_snapshot(repo_root, runner)
    if actual.commit != expected.commit:
        raise BuildError("git HEAD changed while building app-server artifacts")
    if actual.status != expected.status:
        raise BuildError("git status changed while building app-server artifacts")


def atomic_publish_no_replace(source: Path, destination: Path) -> None:
    source_bytes = os.fsencode(source)
    destination_bytes = os.fsencode(destination)
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        renamex_np = getattr(libc, "renamex_np", None)
        if renamex_np is None:
            raise BuildError("atomic no-replace publish is unavailable on macOS")
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        result = renamex_np(source_bytes, destination_bytes, 0x00000004)
    elif sys.platform.startswith("linux"):
        renameat2 = getattr(libc, "renameat2", None)
        if renameat2 is None:
            raise BuildError("atomic no-replace publish is unavailable on Linux")
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        result = renameat2(-100, source_bytes, -100, destination_bytes, 1)
    else:
        raise BuildError(f"atomic no-replace publish is unsupported on {sys.platform}")
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number in {errno.EEXIST, errno.ENOTEMPTY}:
        raise BuildError(f"output directory already exists: {destination}")
    raise BuildError(
        f"atomic no-replace publish failed for {destination}: "
        f"{os.strerror(error_number)}"
    )


def rustc_metadata(
    repo_root: Path, runner: Runner, requested_target: str | None
) -> tuple[str, str, str]:
    rustc_vv = runner.run(["rustc", "-vV"], cwd=repo_root).strip()
    host = next(
        (
            line.removeprefix("host:").strip()
            for line in rustc_vv.splitlines()
            if line.startswith("host:")
        ),
        None,
    )
    if not host:
        raise BuildError("rustc -vV reported no host")
    target = requested_target
    if target is None:
        target = host
    return rustc_vv, target, host


def source_binary(target_dir: Path, target: str) -> Path:
    executable = f"{ARTIFACT_NAME}.exe" if "windows" in target else ARTIFACT_NAME
    return target_dir / target / "release" / executable


def artifact_record(
    generation: str, guard_mode: str, artifact: Path
) -> dict[str, object]:
    size = artifact.stat().st_size
    if size <= 0:
        raise BuildError(f"app-server artifact is empty: {artifact}")
    return {
        "artifactKind": ARTIFACT_NAME,
        "generation": generation,
        "guardMode": guard_mode,
        "sha256": sha256_file(artifact),
        "sizeBytes": size,
    }


def write_read_only_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    path.chmod(0o444)


def validate_probe_result(
    output: str,
    artifacts: Mapping[str, Path],
    records: Mapping[str, Mapping[str, object]],
) -> dict[str, object]:
    try:
        result = json.loads(output)
    except json.JSONDecodeError as error:
        raise BuildError(f"generation probe returned invalid JSON: {error}") from error
    if not isinstance(result, dict) or result.get("verified") is not True:
        raise BuildError("generation probe did not return verified=true")
    if result.get("probe") != "app-server-generation-black-box":
        raise BuildError("generation probe returned an unexpected probe type")
    cases = result.get("cases")
    if not isinstance(cases, list) or len(cases) != 4:
        raise BuildError("generation probe must return exactly four cases")
    cases_by_name: dict[str, Mapping[str, object]] = {}
    for case in cases:
        if not isinstance(case, dict) or not isinstance(case.get("case"), str):
            raise BuildError("generation probe returned an invalid case")
        case_name = case["case"]
        if case_name in cases_by_name:
            raise BuildError(f"generation probe returned duplicate case: {case_name}")
        cases_by_name[case_name] = case
    expected_conflicts = {
        "legacy+legacy",
        "legacyOwner+leaseAwareContender",
        "leaseAwareOwner+legacyContender",
    }
    if set(cases_by_name) != {"leaseAware+leaseAware", *expected_conflicts}:
        raise BuildError("generation probe returned an unexpected case set")
    lease_case = cases_by_name["leaseAware+leaseAware"]
    if (
        lease_case.get("result") != "bothInitialized"
        or lease_case.get("portsDistinct") is not True
    ):
        raise BuildError(
            "generation probe lease pair did not initialize on distinct ports"
        )
    for case_name in expected_conflicts:
        if cases_by_name[case_name].get("result") != "conflictBeforeStateOrListener":
            raise BuildError(f"generation probe conflict case failed: {case_name}")
    identities = {
        "leaseAwareCutover": result.get("leaseAwareArtifact"),
        "legacyFence": result.get("legacyArtifact"),
    }
    for generation, identity in identities.items():
        if not isinstance(identity, dict):
            raise BuildError(f"generation probe omitted {generation} artifact identity")
        record = records[generation]
        if identity.get("sha256") != record["sha256"]:
            raise BuildError(f"generation probe SHA mismatch for {generation}")
        if identity.get("sizeBytes") != record["sizeBytes"]:
            raise BuildError(f"generation probe size mismatch for {generation}")
        reported_path = identity.get("path")
        if (
            not isinstance(reported_path, str)
            or Path(reported_path).resolve() != artifacts[generation].resolve()
        ):
            raise BuildError(f"generation probe path mismatch for {generation}")
    return result


def validate_offline_verifier_result(
    output: str,
    generation: str,
    guard_mode: str,
    record: Mapping[str, object],
) -> dict[str, object]:
    try:
        result = json.loads(output)
    except json.JSONDecodeError as error:
        raise BuildError(f"offline verifier returned invalid JSON: {error}") from error
    if not isinstance(result, dict) or result.get("verified") is not True:
        raise BuildError(f"offline verifier did not verify {generation}")
    expected = {
        "sha256": record["sha256"],
        "sizeBytes": record["sizeBytes"],
        "generation": generation,
        "guardMode": guard_mode,
        "productionWiring": "notConnected",
    }
    for key, value in expected.items():
        if result.get(key) != value:
            raise BuildError(f"offline verifier {key} mismatch for {generation}")
    return result


def build_artifacts(
    config: BuildConfig, runner: Runner | None = None
) -> dict[str, object]:
    runner = runner or SubprocessRunner()
    if config.skip_generation_probe and not (config.dry_run or config.allow_dirty):
        raise BuildError(
            "--skip-generation-probe requires --dry-run or explicit --allow-dirty development mode"
        )
    repo_root, cargo_lock, lock_sha_before = require_repo(config)
    cargo_root = repo_root / "codex-rs"
    git_snapshot = git_metadata(repo_root, runner, config.allow_dirty)
    rustc_vv, target, rustc_host = rustc_metadata(cargo_root, runner, config.target)
    if (
        target != rustc_host
        and not config.dry_run
        and not (config.allow_dirty and config.skip_generation_probe)
    ):
        raise BuildError(
            "target differs from rustc host; cross-target builds require --dry-run or "
            "explicit --allow-dirty --skip-generation-probe development mode"
        )
    commands = {
        generation: cargo_command(target, features)
        for generation, _guard_mode, features in GENERATIONS
    }
    plan = {
        "gitCommit": git_snapshot.commit,
        "gitStatusSha256": git_snapshot.status_sha256,
        "cargoLockSha256": lock_sha_before,
        "rustcVv": rustc_vv,
        "rustcHost": rustc_host,
        "target": target,
        "dirtyTree": git_snapshot.dirty,
        "commands": commands,
        "cargoWorkingDirectory": "codex-rs",
        "generationProbeSkipped": config.skip_generation_probe,
    }
    if config.dry_run:
        return {"dryRun": True, **plan}

    output_dir = config.output_dir.resolve()
    if output_dir.exists():
        raise BuildError(f"output directory already exists: {output_dir}")
    output_dir.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix="crewon-app-server-build-", dir=output_dir.parent
    ) as build_root_value:
        build_root = Path(build_root_value)
        stage_dir = build_root / "stage"
        stage_dir.mkdir()
        receipt_builds: dict[str, object] = {}
        artifacts: dict[str, Path] = {}
        records: dict[str, dict[str, object]] = {}

        for generation, guard_mode, features in GENERATIONS:
            target_dir = build_root / f"target-{generation}"
            environment = os.environ.copy()
            environment["CARGO_TARGET_DIR"] = os.fspath(target_dir)
            command = commands[generation]
            runner.run(command, cwd=cargo_root, env=environment)

            source = source_binary(target_dir, target)
            if not source.is_file():
                raise BuildError(f"Cargo did not produce expected binary: {source}")
            generation_dir = stage_dir / generation
            generation_dir.mkdir()
            artifact = generation_dir / ARTIFACT_NAME
            shutil.copyfile(source, artifact)
            artifact.chmod(0o555)
            record = artifact_record(generation, guard_mode, artifact)
            artifacts[generation] = artifact
            records[generation] = record
            receipt_builds[generation] = {
                "command": command,
                "workingDirectory": "codex-rs",
                "cargoTargetDir": os.fspath(target_dir),
                "features": list(features),
                "artifact": record,
            }

        probe_command = [
            sys.executable,
            os.fspath(repo_root / "scripts" / "probe-app-server-generation.py"),
            "--lease-aware-binary",
            os.fspath(artifacts["leaseAwareCutover"]),
            "--legacy-binary",
            os.fspath(artifacts["legacyFence"]),
            "--crewon-home",
            os.fspath(build_root / "generation-probe-home"),
        ]
        probe_result: dict[str, object] | None = None
        if config.skip_generation_probe:
            probe_receipt: dict[str, object] = {
                "skipped": True,
                "verified": False,
                "reason": "explicit non-authoritative development skip",
                "command": probe_command,
            }
        else:
            probe_home = build_root / "generation-probe-home"
            probe_home.mkdir()
            probe_result = validate_probe_result(
                runner.run(probe_command, cwd=repo_root), artifacts, records
            )
            probe_receipt = {
                "skipped": False,
                "verified": True,
                "command": probe_command,
                "result": probe_result,
            }

        for generation, guard_mode, _features in GENERATIONS:
            if (
                artifact_record(generation, guard_mode, artifacts[generation])
                != records[generation]
            ):
                raise BuildError(
                    f"artifact changed during generation probe: {generation}"
                )

        for generation, guard_mode, _features in GENERATIONS:
            generation_dir = stage_dir / generation
            record = records[generation]
            manifest_path = generation_dir / "artifact-manifest.json"
            allowlist_path = generation_dir / "artifact-allowlist.json"
            write_read_only_json(
                manifest_path,
                {"schemaVersion": 1, "artifact": record},
            )
            write_read_only_json(
                allowlist_path,
                {"schemaVersion": 1, "allowedArtifacts": [record]},
            )
            verifier_command = [
                sys.executable,
                os.fspath(
                    repo_root / "scripts" / "verify-app-server-deployment-artifact.py"
                ),
                "--artifact",
                os.fspath(artifacts[generation]),
                "--manifest",
                os.fspath(manifest_path),
                "--allowlist",
                os.fspath(allowlist_path),
                "--required-generation",
                generation,
            ]
            receipt_builds[generation]["offlineVerification"] = (
                validate_offline_verifier_result(
                    runner.run(verifier_command, cwd=repo_root),
                    generation,
                    guard_mode,
                    record,
                )
            )

        receipt = {
            "schemaVersion": 1,
            "authority": "non-authoritative",
            "productionWiring": "notConnected",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "source": {
                "gitCommit": git_snapshot.commit,
                "cargoLockSha256": lock_sha_before,
                "dirtyTree": git_snapshot.dirty,
                "gitStatusSha256": git_snapshot.status_sha256,
            },
            "toolchain": {
                "rustcVv": rustc_vv,
                "rustcHost": rustc_host,
                "target": target,
            },
            "builds": receipt_builds,
            "generationProbe": probe_receipt,
        }
        write_read_only_json(stage_dir / "build-receipt.json", receipt)
        lock_sha_after = sha256_file(cargo_lock)
        if lock_sha_after != lock_sha_before:
            raise BuildError("Cargo.lock changed while building app-server artifacts")
        require_unchanged_git_snapshot(repo_root, runner, git_snapshot)
        atomic_publish_no_replace(stage_dir, output_dir)

    return {
        "dryRun": False,
        "outputDir": os.fspath(output_dir),
        **plan,
    }


def build_parser() -> argparse.ArgumentParser:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=repo_root)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--target")
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-generation-probe", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = build_artifacts(
            BuildConfig(
                repo_root=args.repo_root,
                output_dir=args.output_dir,
                target=args.target,
                allow_dirty=args.allow_dirty,
                dry_run=args.dry_run,
                skip_generation_probe=args.skip_generation_probe,
            )
        )
    except (BuildError, OSError) as error:
        print(f"artifact build failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
