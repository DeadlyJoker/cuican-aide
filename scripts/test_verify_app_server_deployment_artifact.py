#!/usr/bin/env python3

import hashlib
import json
from pathlib import Path
import os
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("verify-app-server-deployment-artifact.py")


class DeploymentArtifactVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.artifact = self.root / "crewon-app-server"
        self.artifact.write_bytes(b"#!/bin/sh\nexit 0\n")
        self.artifact.chmod(0o555)
        self.sha256 = hashlib.sha256(self.artifact.read_bytes()).hexdigest()
        self.size_bytes = self.artifact.stat().st_size
        self.manifest = self.root / "artifact-manifest.json"
        self.allowlist = self.root / "artifact-allowlist.json"
        self.write_controls()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def artifact_record(
        self,
        *,
        generation: str = "leaseAwareCutover",
        guard_mode: str = "LeaseAwareShared",
        sha256: str | None = None,
        size_bytes: int | None = None,
    ) -> dict[str, object]:
        return {
            "artifactKind": "crewon-app-server",
            "generation": generation,
            "guardMode": guard_mode,
            "sha256": sha256 or self.sha256,
            "sizeBytes": size_bytes or self.size_bytes,
        }

    def write_read_only_json(self, path: Path, value: object) -> None:
        if path.exists():
            path.chmod(0o600)
        path.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
        path.chmod(0o444)

    def write_controls(
        self,
        *,
        manifest_record: dict[str, object] | None = None,
        allowed_records: list[dict[str, object]] | None = None,
    ) -> None:
        record = manifest_record or self.artifact_record()
        self.write_read_only_json(
            self.manifest, {"schemaVersion": 1, "artifact": record}
        )
        self.write_read_only_json(
            self.allowlist,
            {
                "schemaVersion": 1,
                "allowedArtifacts": allowed_records or [record],
            },
        )

    def run_verifier(
        self, *, required_generation: str = "leaseAwareCutover"
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                os.fspath(SCRIPT),
                "--artifact",
                os.fspath(self.artifact),
                "--manifest",
                os.fspath(self.manifest),
                "--allowlist",
                os.fspath(self.allowlist),
                "--required-generation",
                required_generation,
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_accepts_exact_lease_aware_artifact(self) -> None:
        result = self.run_verifier()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            {
                "artifactPath": os.fspath(self.artifact),
                "generation": "leaseAwareCutover",
                "guardMode": "LeaseAwareShared",
                "productionWiring": "notConnected",
                "sha256": self.sha256,
                "sizeBytes": self.size_bytes,
                "verified": True,
            },
        )

    def test_accepts_exact_legacy_fence_artifact(self) -> None:
        legacy = self.artifact_record(
            generation="legacyFence", guard_mode="LegacyExclusive"
        )
        self.write_controls(manifest_record=legacy, allowed_records=[legacy])
        result = self.run_verifier(required_generation="legacyFence")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["guardMode"], "LegacyExclusive")

    def test_rejects_pre_fence_sha_not_in_allowlist(self) -> None:
        unknown = "0" * 64
        self.write_controls(allowed_records=[self.artifact_record(sha256=unknown)])
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("not deployment-allowed", result.stderr)

    def test_rejects_artifact_bytes_that_do_not_match_manifest(self) -> None:
        self.artifact.chmod(0o755)
        self.artifact.write_bytes(b"#!/bin/sh\nexit 7\n")
        self.artifact.chmod(0o555)
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("do not match the immutable manifest", result.stderr)

    def test_rejects_generation_mismatch(self) -> None:
        result = self.run_verifier(required_generation="legacyFence")
        self.assertEqual(result.returncode, 1)
        self.assertIn("required generation", result.stderr)

    def test_rejects_guard_mode_mismatch(self) -> None:
        invalid = self.artifact_record(guard_mode="LegacyExclusive")
        self.write_controls(manifest_record=invalid, allowed_records=[invalid])
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("guardMode must be LeaseAwareShared", result.stderr)

    def test_rejects_mutable_artifact(self) -> None:
        self.artifact.chmod(0o755)
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("must be immutable", result.stderr)

    def test_rejects_artifact_symlink(self) -> None:
        target = self.root / "real-app-server"
        self.artifact.rename(target)
        self.artifact.symlink_to(target)
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot open app-server artifact", result.stderr)

    def test_rejects_mutable_allowlist(self) -> None:
        self.allowlist.chmod(0o644)
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("artifact allowlist must be immutable", result.stderr)

    def test_rejects_duplicate_manifest_keys(self) -> None:
        self.manifest.chmod(0o600)
        self.manifest.write_text(
            '{"schemaVersion":1,"schemaVersion":1,"artifact":{}}',
            encoding="utf-8",
        )
        self.manifest.chmod(0o444)
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("duplicate JSON key", result.stderr)


if __name__ == "__main__":
    unittest.main()
