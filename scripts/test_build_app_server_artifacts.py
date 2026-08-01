#!/usr/bin/env python3

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, call, patch


SCRIPT = Path(__file__).with_name("build-app-server-artifacts.py")
SPEC = importlib.util.spec_from_file_location("build_app_server_artifacts", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
BUILDER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BUILDER
SPEC.loader.exec_module(BUILDER)


class FakeRunner:
    def __init__(
        self,
        *,
        dirty: bool = False,
        mutate_lock: bool = False,
        probe_verified: bool = True,
        probe_sha_mismatch: bool = False,
        probe_type: str = "app-server-generation-black-box",
        probe_cases_valid: bool = True,
        empty_generation: str | None = None,
        verifier_verified: bool = True,
        change_status_on_final_check: bool = False,
        change_head_on_final_check: bool = False,
        race_output: Path | None = None,
    ) -> None:
        self.dirty = dirty
        self.mutate_lock = mutate_lock
        self.probe_verified = probe_verified
        self.probe_sha_mismatch = probe_sha_mismatch
        self.probe_type = probe_type
        self.probe_cases_valid = probe_cases_valid
        self.empty_generation = empty_generation
        self.verifier_verified = verifier_verified
        self.change_status_on_final_check = change_status_on_final_check
        self.change_head_on_final_check = change_head_on_final_check
        self.race_output = race_output
        self.commands: list[tuple[list[str], dict[str, str] | None]] = []
        self.source_inodes: dict[str, int] = {}
        self.status_calls = 0
        self.rev_parse_calls = 0

    def run(
        self,
        command: list[str],
        *,
        cwd: Path,
        env: dict[str, str] | None = None,
    ) -> str:
        self.commands.append((list(command), dict(env) if env is not None else None))
        if command[:3] == ["git", "status", "--porcelain=v1"]:
            self.status_calls += 1
            if self.status_calls == 2 and self.race_output is not None:
                self.race_output.mkdir(parents=True)
                (self.race_output / "racer").write_text("racer\n")
            if self.status_calls == 2 and self.change_status_on_final_check:
                return " M changed-during-build\n"
            return " M dirty-file\n" if self.dirty else ""
        if command[:3] == ["git", "rev-parse", "HEAD"]:
            self.rev_parse_calls += 1
            if self.rev_parse_calls >= 3 and self.change_head_on_final_check:
                return "b" * 40 + "\n"
            return "a" * 40 + "\n"
        if command == ["rustc", "-vV"]:
            return "rustc 1.95.0\nhost: x86_64-unknown-linux-gnu\n"
        if command[:2] == ["cargo", "build"]:
            assert env is not None
            target_dir = Path(env["CARGO_TARGET_DIR"])
            target = command[command.index("--target") + 1]
            generation = (
                "legacyFence" if "--features" in command else "leaseAwareCutover"
            )
            binary = target_dir / target / "release" / "crewon-app-server"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(
                b""
                if generation == self.empty_generation
                else f"binary:{generation}".encode()
            )
            binary.chmod(0o755)
            self.source_inodes[generation] = binary.stat().st_ino
            if self.mutate_lock and generation == "legacyFence":
                (cwd / "Cargo.lock").write_text("changed\n")
            return ""
        if len(command) > 1 and command[1].endswith("probe-app-server-generation.py"):
            lease_path = Path(command[command.index("--lease-aware-binary") + 1])
            legacy_path = Path(command[command.index("--legacy-binary") + 1])

            def identity(path: Path) -> dict[str, object]:
                return {
                    "path": os.fspath(path),
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "sizeBytes": path.stat().st_size,
                }

            lease_identity = identity(lease_path)
            if self.probe_sha_mismatch:
                lease_identity["sha256"] = "0" * 64
            cases = [
                {
                    "case": "leaseAware+leaseAware",
                    "result": "bothInitialized",
                    "portsDistinct": True,
                },
                {"case": "legacy+legacy", "result": "conflictBeforeStateOrListener"},
                {
                    "case": "legacyOwner+leaseAwareContender",
                    "result": "conflictBeforeStateOrListener",
                },
                {
                    "case": "leaseAwareOwner+legacyContender",
                    "result": "conflictBeforeStateOrListener",
                },
            ]
            if not self.probe_cases_valid:
                cases[-1]["result"] = "unexpected"
            return json.dumps(
                {
                    "verified": self.probe_verified,
                    "probe": self.probe_type,
                    "leaseAwareArtifact": lease_identity,
                    "legacyArtifact": identity(legacy_path),
                    "cases": cases,
                }
            )
        if len(command) > 1 and command[1].endswith(
            "verify-app-server-deployment-artifact.py"
        ):
            artifact = Path(command[command.index("--artifact") + 1])
            generation = command[command.index("--required-generation") + 1]
            guard_mode = (
                "LegacyExclusive" if generation == "legacyFence" else "LeaseAwareShared"
            )
            return json.dumps(
                {
                    "verified": self.verifier_verified,
                    "artifactPath": os.fspath(artifact),
                    "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                    "sizeBytes": artifact.stat().st_size,
                    "generation": generation,
                    "guardMode": guard_mode,
                    "productionWiring": "notConnected",
                }
            )
        raise AssertionError(f"unexpected command: {command}")


class AppServerArtifactBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.repo = self.root / "repo"
        (self.repo / "codex-rs").mkdir(parents=True)
        (self.repo / "codex-rs" / "Cargo.toml").write_text("[workspace]\n")
        (self.repo / "codex-rs" / "Cargo.lock").write_text("lock-v1\n")
        self.output = self.root / "dist" / "artifact-set"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def config(
        self,
        *,
        allow_dirty: bool = False,
        dry_run: bool = False,
        skip_generation_probe: bool = False,
        target: str | None = None,
    ):
        return BUILDER.BuildConfig(
            repo_root=self.repo,
            output_dir=self.output,
            target=target,
            allow_dirty=allow_dirty,
            dry_run=dry_run,
            skip_generation_probe=skip_generation_probe,
        )

    def test_builds_isolated_variants_and_atomically_packages_controls(self) -> None:
        runner = FakeRunner()
        result = BUILDER.build_artifacts(self.config(), runner)

        self.assertEqual(result["outputDir"], os.fspath(self.output.resolve()))
        cargo_calls = [
            entry for entry in runner.commands if entry[0][:2] == ["cargo", "build"]
        ]
        self.assertEqual(len(cargo_calls), 2)
        target_dirs = {entry[1]["CARGO_TARGET_DIR"] for entry in cargo_calls}
        self.assertEqual(len(target_dirs), 2)
        for command, _environment in cargo_calls:
            self.assertEqual(
                command[command.index("--manifest-path") + 1], "Cargo.toml"
            )
            self.assertIn("--frozen", command)
            self.assertIn("--release", command)
            self.assertIn("--no-default-features", command)
        self.assertNotIn("--features", cargo_calls[0][0])
        self.assertEqual(
            cargo_calls[1][0][cargo_calls[1][0].index("--features") + 1],
            "legacy-fence-artifact",
        )

        expectations = {
            "leaseAwareCutover": "LeaseAwareShared",
            "legacyFence": "LegacyExclusive",
        }
        for generation, guard_mode in expectations.items():
            generation_dir = self.output / generation
            artifact = generation_dir / "crewon-app-server"
            manifest = json.loads(
                (generation_dir / "artifact-manifest.json").read_text()
            )
            allowlist = json.loads(
                (generation_dir / "artifact-allowlist.json").read_text()
            )
            record = manifest["artifact"]
            self.assertEqual(
                set(record),
                {"artifactKind", "generation", "guardMode", "sha256", "sizeBytes"},
            )
            self.assertEqual(record["generation"], generation)
            self.assertEqual(record["guardMode"], guard_mode)
            self.assertEqual(
                record["sha256"], hashlib.sha256(artifact.read_bytes()).hexdigest()
            )
            self.assertEqual(
                allowlist, {"schemaVersion": 1, "allowedArtifacts": [record]}
            )
            self.assertEqual(artifact.stat().st_mode & 0o777, 0o555)
            self.assertNotEqual(
                artifact.stat().st_ino, runner.source_inodes[generation]
            )

        receipt = json.loads((self.output / "build-receipt.json").read_text())
        self.assertEqual(receipt["authority"], "non-authoritative")
        self.assertEqual(receipt["productionWiring"], "notConnected")
        self.assertEqual(receipt["source"]["gitCommit"], "a" * 40)
        self.assertEqual(
            receipt["source"]["gitStatusSha256"], hashlib.sha256(b"").hexdigest()
        )
        self.assertEqual(
            receipt["source"]["cargoLockSha256"],
            hashlib.sha256(b"lock-v1\n").hexdigest(),
        )
        self.assertEqual(receipt["toolchain"]["target"], "x86_64-unknown-linux-gnu")
        self.assertEqual(
            receipt["builds"]["leaseAwareCutover"]["workingDirectory"],
            "codex-rs",
        )
        self.assertEqual(receipt["toolchain"]["rustcHost"], "x86_64-unknown-linux-gnu")
        self.assertEqual(receipt["generationProbe"]["skipped"], False)
        self.assertEqual(receipt["generationProbe"]["verified"], True)
        probe_calls = [
            command
            for command, _env in runner.commands
            if len(command) > 1
            and command[1].endswith("probe-app-server-generation.py")
        ]
        self.assertEqual(len(probe_calls), 1)
        verifier_calls = [
            command
            for command, _env in runner.commands
            if len(command) > 1
            and command[1].endswith("verify-app-server-deployment-artifact.py")
        ]
        self.assertEqual(len(verifier_calls), 2)
        self.assertEqual(
            receipt["builds"]["legacyFence"]["offlineVerification"]["verified"],
            True,
        )

    def test_rejects_dirty_tree_by_default_before_cargo_runs(self) -> None:
        runner = FakeRunner(dirty=True)
        with self.assertRaisesRegex(BUILDER.BuildError, "dirty git tree"):
            BUILDER.build_artifacts(self.config(), runner)
        self.assertFalse(self.output.exists())
        self.assertFalse(
            any(command[:2] == ["cargo", "build"] for command, _env in runner.commands)
        )

    def test_allows_explicit_dirty_tree_and_records_it(self) -> None:
        runner = FakeRunner(dirty=True)
        BUILDER.build_artifacts(self.config(allow_dirty=True), runner)
        receipt = json.loads((self.output / "build-receipt.json").read_text())
        self.assertTrue(receipt["source"]["dirtyTree"])
        self.assertEqual(
            receipt["source"]["gitStatusSha256"],
            hashlib.sha256(b" M dirty-file\n").hexdigest(),
        )

    def test_source_status_change_fails_before_publish(self) -> None:
        runner = FakeRunner(change_status_on_final_check=True)
        with self.assertRaisesRegex(BUILDER.BuildError, "git status changed"):
            BUILDER.build_artifacts(self.config(), runner)
        self.assertFalse(self.output.exists())

    def test_source_head_change_fails_before_publish(self) -> None:
        runner = FakeRunner(change_head_on_final_check=True)
        with self.assertRaisesRegex(BUILDER.BuildError, "git HEAD changed"):
            BUILDER.build_artifacts(self.config(), runner)
        self.assertFalse(self.output.exists())

    def test_cargo_lock_change_fails_without_publishing_partial_stage(self) -> None:
        runner = FakeRunner(mutate_lock=True)
        with self.assertRaisesRegex(BUILDER.BuildError, "Cargo.lock changed"):
            BUILDER.build_artifacts(self.config(), runner)
        self.assertFalse(self.output.exists())

    def test_dry_run_emits_commands_without_build_or_output(self) -> None:
        runner = FakeRunner()
        result = BUILDER.build_artifacts(self.config(dry_run=True), runner)
        self.assertTrue(result["dryRun"])
        self.assertEqual(
            result["commands"]["legacyFence"][-2:],
            ["--features", "legacy-fence-artifact"],
        )
        self.assertFalse(self.output.exists())
        self.assertFalse(
            any(command[:2] == ["cargo", "build"] for command, _env in runner.commands)
        )

    def test_probe_identity_mismatch_fails_without_publishing(self) -> None:
        runner = FakeRunner(probe_sha_mismatch=True)
        with self.assertRaisesRegex(BUILDER.BuildError, "probe SHA mismatch"):
            BUILDER.build_artifacts(self.config(), runner)
        self.assertFalse(self.output.exists())

    def test_probe_verified_false_fails_without_publishing(self) -> None:
        runner = FakeRunner(probe_verified=False)
        with self.assertRaisesRegex(BUILDER.BuildError, "verified=true"):
            BUILDER.build_artifacts(self.config(), runner)
        self.assertFalse(self.output.exists())

    def test_probe_type_or_case_mismatch_fails_without_publishing(self) -> None:
        for runner, message in [
            (FakeRunner(probe_type="other-probe"), "unexpected probe type"),
            (FakeRunner(probe_cases_valid=False), "conflict case failed"),
        ]:
            with self.subTest(message=message):
                with self.assertRaisesRegex(BUILDER.BuildError, message):
                    BUILDER.build_artifacts(self.config(), runner)
                self.assertFalse(self.output.exists())

    def test_offline_verifier_failure_does_not_publish(self) -> None:
        with self.assertRaisesRegex(BUILDER.BuildError, "did not verify"):
            BUILDER.build_artifacts(self.config(), FakeRunner(verifier_verified=False))
        self.assertFalse(self.output.exists())

    def test_empty_artifact_is_rejected_before_probe_or_publish(self) -> None:
        runner = FakeRunner(empty_generation="legacyFence")
        with self.assertRaisesRegex(BUILDER.BuildError, "artifact is empty"):
            BUILDER.build_artifacts(self.config(), runner)
        self.assertFalse(self.output.exists())

    def test_cross_target_default_probe_fails_before_cargo(self) -> None:
        runner = FakeRunner()
        with self.assertRaisesRegex(
            BUILDER.BuildError, "target differs from rustc host"
        ):
            BUILDER.build_artifacts(
                self.config(target="aarch64-unknown-linux-gnu"), runner
            )
        self.assertFalse(self.output.exists())
        self.assertFalse(
            any(command[:2] == ["cargo", "build"] for command, _env in runner.commands)
        )

    def test_cross_target_is_allowed_for_dry_run(self) -> None:
        result = BUILDER.build_artifacts(
            self.config(target="aarch64-unknown-linux-gnu", dry_run=True), FakeRunner()
        )
        self.assertEqual(result["target"], "aarch64-unknown-linux-gnu")
        self.assertFalse(self.output.exists())

    def test_probe_skip_requires_explicit_development_mode(self) -> None:
        with self.assertRaisesRegex(BUILDER.BuildError, "requires --dry-run"):
            BUILDER.build_artifacts(
                self.config(skip_generation_probe=True), FakeRunner()
            )
        self.assertFalse(self.output.exists())

    def test_explicit_development_skip_is_recorded(self) -> None:
        runner = FakeRunner()
        BUILDER.build_artifacts(
            self.config(allow_dirty=True, skip_generation_probe=True), runner
        )
        receipt = json.loads((self.output / "build-receipt.json").read_text())
        self.assertEqual(receipt["productionWiring"], "notConnected")
        self.assertEqual(receipt["generationProbe"]["skipped"], True)
        self.assertEqual(receipt["generationProbe"]["verified"], False)
        self.assertFalse(
            any(
                len(command) > 1
                and command[1].endswith("probe-app-server-generation.py")
                for command, _env in runner.commands
            )
        )

    def test_existing_output_directory_is_not_replaced(self) -> None:
        self.output.mkdir(parents=True)
        marker = self.output / "keep"
        marker.write_text("keep")
        with self.assertRaisesRegex(BUILDER.BuildError, "already exists"):
            BUILDER.build_artifacts(self.config(), FakeRunner())
        self.assertEqual(marker.read_text(), "keep")

    def test_racing_output_directory_is_not_replaced(self) -> None:
        runner = FakeRunner(race_output=self.output)
        with self.assertRaisesRegex(BUILDER.BuildError, "already exists"):
            BUILDER.build_artifacts(self.config(), runner)
        self.assertEqual((self.output / "racer").read_text(), "racer\n")


class SubprocessRunnerTests(unittest.TestCase):
    def test_timeout_terminates_then_kills_process_group_and_waits(self) -> None:
        process = Mock()
        process.pid = 4321
        process.communicate.side_effect = [
            BUILDER.subprocess.TimeoutExpired(["hung"], 0.25),
            BUILDER.subprocess.TimeoutExpired(["hung"], 0.1),
            ("", "still hung"),
        ]
        process.wait.return_value = -9
        environment = {
            "CREWON_APP_SERVER_BUILD_TIMEOUT_DEFAULT_SECONDS": "0.25",
            "CREWON_APP_SERVER_BUILD_TIMEOUT_TERMINATE_GRACE_SECONDS": "0.1",
        }
        with (
            patch.dict(os.environ, environment, clear=False),
            patch.object(BUILDER.subprocess, "Popen", return_value=process) as popen,
            patch.object(BUILDER.os, "killpg") as killpg,
        ):
            with self.assertRaisesRegex(BUILDER.BuildError, "timed out after 0.25s"):
                BUILDER.SubprocessRunner().run(["hung"], cwd=Path("/tmp"))

        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertEqual(
            killpg.call_args_list,
            [
                call(4321, BUILDER.signal.SIGTERM),
                call(4321, BUILDER.signal.SIGKILL),
            ],
        )
        self.assertEqual(
            process.communicate.call_args_list,
            [
                call(timeout=0.25),
                call(timeout=0.1),
                call(),
            ],
        )
        process.wait.assert_called_once_with()

    def test_command_categories_have_independent_timeout_overrides(self) -> None:
        environment = {
            "CREWON_APP_SERVER_BUILD_TIMEOUT_CARGO_SECONDS": "12",
            "CREWON_APP_SERVER_BUILD_TIMEOUT_PROBE_SECONDS": "7",
        }
        runner = BUILDER.SubprocessRunner()
        with patch.dict(os.environ, environment, clear=False):
            self.assertEqual(runner._timeout_seconds(["cargo", "build"]), 12)
            self.assertEqual(
                runner._timeout_seconds(
                    [sys.executable, "/tmp/probe-app-server-generation.py"]
                ),
                7,
            )


if __name__ == "__main__":
    unittest.main()
