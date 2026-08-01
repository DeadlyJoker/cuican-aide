#!/usr/bin/env python3

import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).with_name("crewon-dev.sh")


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def wait_until(predicate, *, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("condition was not satisfied before the timeout")


class CrewonDevProcessHarness:
    def __init__(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        # macOS exposes temporary directories through /var while process cwd is
        # reported through the canonical /private/var path. Use the canonical
        # path so the harness exercises the script's exact cwd ownership check.
        self.root = Path(self.temp_dir.name).resolve()
        self.repo = self.root / "cuican-aide"
        self.external_cwd = self.root / "external"
        self.bin_dir = self.root / "bin"
        self.backend_port = reserve_port()
        self.ui_port = reserve_port()
        self.backend_url = f"ws://127.0.0.1:{self.backend_port}"
        self.starts_file = self.repo / ".crewon" / "dev" / "fake-backend-starts"
        self.log_path = self.root / "crewon-dev.log"
        self.dev_process: subprocess.Popen[bytes] | None = None
        self.log_file = None
        self.processes: list[subprocess.Popen[bytes]] = []
        self._create_fixture()

    def _create_fixture(self) -> None:
        (self.repo / "scripts").mkdir(parents=True)
        (self.repo / "apps" / "crewon-ui").mkdir(parents=True)
        (self.repo / ".crewon" / "dev").mkdir(parents=True)
        self.external_cwd.mkdir()
        self.bin_dir.mkdir()
        shutil.copy2(SCRIPT, self.repo / "scripts" / "crewon-dev.sh")

        fake_server = self.repo / "scripts" / "fake-app-server.py"
        fake_server.write_text(
            """#!/usr/bin/env python3
import os
from pathlib import Path
import signal
import socket
import sys

host = os.environ["CREWON_DEV_BACKEND_HOST"]
port = int(os.environ["CREWON_DEV_BACKEND_PORT"])
starts_file = Path(os.environ["CREWON_DEV_TEST_STARTS_FILE"])
starts_file.parent.mkdir(parents=True, exist_ok=True)
with starts_file.open("a", encoding="utf-8") as stream:
    stream.write(f"{os.getpid()}\\n")

listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind((host, port))
listener.listen()

def stop(_signum, _frame):
    listener.close()
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while True:
    connection, _address = listener.accept()
    connection.close()
""",
            encoding="utf-8",
        )
        fake_server.chmod(0o755)

        app_server = self.repo / "scripts" / "crewon-app-server.sh"
        app_server.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$repo_root/scripts/fake-app-server.py" \
  crewon-app-server --listen \
  "ws://${CREWON_DEV_BACKEND_HOST}:${CREWON_DEV_BACKEND_PORT}"
""",
            encoding="utf-8",
        )
        app_server.chmod(0o755)

        fake_pnpm = self.bin_dir / "pnpm"
        fake_pnpm.write_text(
            """#!/usr/bin/env python3
import signal
import time

running = True
def stop(_signum, _frame):
    global running
    running = False

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while running:
    time.sleep(0.05)
""",
            encoding="utf-8",
        )
        fake_pnpm.chmod(0o755)

    def environment(self) -> dict[str, str]:
        return {
            **os.environ,
            "PATH": f"{self.bin_dir}{os.pathsep}{os.environ['PATH']}",
            "CREWON_DEV_BACKEND_HOST": "127.0.0.1",
            "CREWON_DEV_BACKEND_PORT": str(self.backend_port),
            "CREWON_DEV_UI_PORT": str(self.ui_port),
            "CREWON_DEV_BACKEND_READY_TIMEOUT": "10",
            "CREWON_DEV_BACKEND_LOST_CHECKS": "1",
            "CREWON_DEV_TEST_STARTS_FILE": os.fspath(self.starts_file),
        }

    def spawn_matching_sleeper(self, cwd: Path) -> subprocess.Popen[bytes]:
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import time; time.sleep(300)",
                "crewon-app-server",
                "--listen",
                self.backend_url,
            ],
            cwd=cwd,
        )
        self.processes.append(process)
        return process

    def start(self) -> None:
        self.log_file = self.log_path.open("wb")
        self.dev_process = subprocess.Popen(
            ["bash", os.fspath(self.repo / "scripts" / "crewon-dev.sh")],
            cwd=self.repo,
            env=self.environment(),
            stdout=self.log_file,
            stderr=subprocess.STDOUT,
        )

    def backend_starts(self) -> list[int]:
        if not self.starts_file.exists():
            return []
        return [
            int(line)
            for line in self.starts_file.read_text(encoding="utf-8").splitlines()
            if line
        ]

    def listening_pids(self) -> list[int]:
        result = subprocess.run(
            [
                "lsof",
                "-nP",
                f"-iTCP:{self.backend_port}",
                "-sTCP:LISTEN",
                "-t",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        return [int(line) for line in result.stdout.splitlines() if line]

    def assert_running(self) -> None:
        if self.dev_process is not None and self.dev_process.poll() is not None:
            log = self.log_path.read_text(encoding="utf-8")
            raise AssertionError(
                f"crewon-dev exited with {self.dev_process.returncode}:\n{log}"
            )

    def close(self) -> None:
        if self.dev_process is not None and self.dev_process.poll() is None:
            self.dev_process.send_signal(signal.SIGTERM)
            try:
                self.dev_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.dev_process.kill()
                self.dev_process.wait(timeout=5)
        if self.log_file is not None:
            self.log_file.close()
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
        self.temp_dir.cleanup()


class CrewonDevTests(unittest.TestCase):
    def setUp(self) -> None:
        self.harness = CrewonDevProcessHarness()

    def tearDown(self) -> None:
        self.harness.close()

    def test_startup_removes_port_free_repo_process_but_preserves_external(
        self,
    ) -> None:
        stale = self.harness.spawn_matching_sleeper(self.harness.repo)
        external = self.harness.spawn_matching_sleeper(self.harness.external_cwd)

        self.harness.start()
        wait_until(lambda: stale.poll() is not None)
        wait_until(lambda: len(self.harness.backend_starts()) == 1)
        backend_pid = self.harness.backend_starts()[0]
        wait_until(lambda: self.harness.listening_pids() == [backend_pid])

        self.harness.assert_running()
        self.assertIsNone(external.poll())
        self.assertEqual(self.harness.listening_pids(), [backend_pid])

    def test_restart_leaves_exactly_one_repo_listener(self) -> None:
        self.harness.start()
        wait_until(lambda: len(self.harness.backend_starts()) == 1)
        original_pid = self.harness.backend_starts()[0]
        wait_until(lambda: self.harness.listening_pids() == [original_pid])

        restart_request = (
            self.harness.repo / ".crewon" / "dev" / "app-server-restart-request"
        )
        restart_request.touch()
        wait_until(lambda: len(self.harness.backend_starts()) == 2)
        replacement_pid = self.harness.backend_starts()[1]
        wait_until(lambda: self.harness.listening_pids() == [replacement_pid])

        self.harness.assert_running()
        self.assertNotEqual(replacement_pid, original_pid)
        self.assertEqual(self.harness.listening_pids(), [replacement_pid])


if __name__ == "__main__":
    unittest.main()
