#!/usr/bin/env python3

import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("setup-local-provider-runtime.py")
SPEC = importlib.util.spec_from_file_location("setup_local_provider_runtime", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
HARNESS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = HARNESS
SPEC.loader.exec_module(HARNESS)


class LocalProviderRuntimeHarnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.repo = self.root / "cuican-aide"
        self.agent_platform = self.root / "agent-platform"
        (self.repo / "scripts").mkdir(parents=True)
        (self.repo / ".crewon").mkdir()
        for relative in HARNESS.AGENT_PLATFORM_REQUIRED_FILES:
            target = self.agent_platform / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("{}\n", encoding="utf-8")
        (self.agent_platform / "backend" / "app" / "main.py").write_text(
            'app.mount("/identity/v1", identity_app)\n'
            'app.mount("/provider/v3", provider_app)\n',
            encoding="utf-8",
        )
        (self.repo / ".gitignore").write_text(".crewon/.env\n", encoding="utf-8")
        (self.repo / "scripts" / "crewon-control-web-dev.mjs").write_text(
            'join(repositoryRoot, ".crewon", "dev-ui.env");\n',
            encoding="utf-8",
        )
        (self.repo / ".crewon" / ".env").write_text(
            "AICUICAN_API_KEY=user-owned-key\nCUSTOM_SETTING=keep-me\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def invoke(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                os.fspath(SCRIPT),
                "--repo-root",
                os.fspath(self.repo),
                "--agent-platform-root",
                os.fspath(self.agent_platform),
                *arguments,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_generation_is_idempotent_and_checkable(self) -> None:
        first = self.invoke()
        self.assertEqual(first.returncode, 0, first.stderr)
        runtime = self.repo / ".crewon" / "dev" / "provider-runtime"
        private_before = {
            path.name: path.read_bytes() for path in (runtime / "private").iterdir()
        }

        second = self.invoke()
        self.assertEqual(second.returncode, 0, second.stderr)
        private_after = {
            path.name: path.read_bytes() for path in (runtime / "private").iterdir()
        }
        self.assertEqual(private_after, private_before)

        checked = self.invoke("--check")
        self.assertEqual(checked.returncode, 0, checked.stderr)
        for private_key in (runtime / "private").iterdir():
            self.assertEqual(stat.S_IMODE(private_key.stat().st_mode), 0o600)

        agent_env = runtime / "agent-platform.env.sh"
        self.assertEqual(stat.S_IMODE(agent_env.stat().st_mode), 0o600)
        environment_text = agent_env.read_text(encoding="utf-8")
        self.assertNotIn("BEGIN PRIVATE KEY", environment_text)
        self.assertIn("export MCP_SERVICE_URL=\n", environment_text)
        self.assertIn("development-local-filesystem", environment_text)
        for disabled_service in (
            "TRACE_DISABLED",
            "HEALTH_SCHEDULER_DISABLED",
            "APPLICATION_CHANNEL_WORKER_DISABLED",
            "WECHAT_WORK_BOT_RUNTIME_DISABLED",
        ):
            self.assertIn(f"export {disabled_service}=true", environment_text)
        self.assertIn(
            f"export PERMISSION_SERVICE_URL={HARNESS.DEFAULT_PERMISSION_SERVICE_URL}",
            environment_text,
        )

        dev_ui_lines = (self.repo / ".crewon" / "dev-ui.env").read_text().splitlines()
        self.assertEqual(dev_ui_lines, ["VITE_CREWON_PRINCIPAL_SESSION_ENABLED=true"])
        crewon_env = (self.repo / ".crewon" / ".env").read_text(encoding="utf-8")
        self.assertIn("AICUICAN_API_KEY=user-owned-key", crewon_env)
        self.assertIn("CUSTOM_SETTING=keep-me", crewon_env)
        self.assertEqual(crewon_env.count(HARNESS.BEGIN_MARKER), 1)
        self.assertEqual(crewon_env.count(HARNESS.END_MARKER), 1)
        self.assertIn(f"{HARNESS.DEFAULT_AGENT_PLATFORM_URL}/provider/v3/", crewon_env)
        keyset = json.loads(
            (runtime / "public" / "crewon-provider.json").read_text(encoding="utf-8")
        )
        self.assertEqual(list(keyset), [HARNESS.KEYS["crewon-provider"]])

    def test_custom_service_origins_are_checkable(self) -> None:
        arguments = (
            "--agent-platform-url",
            "http://127.0.0.1:18002/",
            "--permission-service-url",
            "http://127.0.0.1:18010/",
        )
        generated = self.invoke(*arguments)
        self.assertEqual(generated.returncode, 0, generated.stderr)

        checked = self.invoke(*arguments, "--check")
        self.assertEqual(checked.returncode, 0, checked.stderr)
        crewon_env = (self.repo / ".crewon" / ".env").read_text(encoding="utf-8")
        self.assertIn("http://127.0.0.1:18002/provider/v3/", crewon_env)
        agent_env = (
            self.repo / ".crewon" / "dev" / "provider-runtime" / "agent-platform.env.sh"
        ).read_text(encoding="utf-8")
        self.assertIn("http://127.0.0.1:18010", agent_env)

    def test_check_rejects_extra_frontend_environment(self) -> None:
        generated = self.invoke()
        self.assertEqual(generated.returncode, 0, generated.stderr)
        dev_ui = self.repo / ".crewon" / "dev-ui.env"
        dev_ui.write_text(
            "VITE_CREWON_PRINCIPAL_SESSION_ENABLED=true\nSERVER_SECRET=leak\n",
            encoding="utf-8",
        )
        dev_ui.chmod(0o600)

        checked = self.invoke("--check")
        self.assertNotEqual(checked.returncode, 0)
        self.assertIn("unexpected values", checked.stderr)

    def test_controlled_block_replacement_preserves_user_values(self) -> None:
        original = (
            "AICUICAN_API_KEY=first\n\n"
            f"{HARNESS.BEGIN_MARKER}\nold=true\n{HARNESS.END_MARKER}\n\n"
            "AICUICAN_API_KEY=second\n"
        )
        updated = HARNESS.replace_controlled_block(original, "managed=true")
        self.assertEqual(updated.count("AICUICAN_API_KEY="), 2)
        self.assertIn("AICUICAN_API_KEY=first", updated)
        self.assertIn("AICUICAN_API_KEY=second", updated)
        self.assertIn("managed=true", updated)
        self.assertNotIn("old=true", updated)

    def test_check_rejects_checkout_without_provider_v3_runtime(self) -> None:
        generated = self.invoke()
        self.assertEqual(generated.returncode, 0, generated.stderr)
        (
            self.agent_platform
            / "backend"
            / "app"
            / "modules"
            / "provider_run"
            / "production_composition.py"
        ).unlink()

        checked = self.invoke("--check")
        self.assertNotEqual(checked.returncode, 0)
        self.assertIn("does not provide the Provider v3 harness", checked.stderr)

    def test_repo_wide_crewon_ignore_covers_generated_harness_files(self) -> None:
        (self.repo / ".gitignore").write_text(".crewon/\n", encoding="utf-8")
        generated = self.invoke()
        self.assertEqual(generated.returncode, 0, generated.stderr)

        checked = self.invoke("--check")
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(
            (self.repo / ".gitignore").read_text(encoding="utf-8"),
            ".crewon/\n",
        )


if __name__ == "__main__":
    unittest.main()
