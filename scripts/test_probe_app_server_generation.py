#!/usr/bin/env python3

import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock


PROBE = Path(__file__).with_name("probe-app-server-generation.py")


def load_probe_module():
    specification = importlib.util.spec_from_file_location(
        "probe_app_server_generation", PROBE
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


PROBE_MODULE = load_probe_module()

FAKE_SERVER = r"""#!__PYTHON__
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import sys
import time

running = True

def stop(_signum, _frame):
    global running
    running = False

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
mode = "legacy" if "legacy" in Path(sys.argv[0]).name else "lease"
if "PROBE_TEST_SECRET" in os.environ:
    print("probe inherited host secret", file=sys.stderr, flush=True)
    raise SystemExit(98)
home = Path(os.environ["CREWON_HOME"])
home.mkdir(parents=True, exist_ok=True)
lock_file = (home / ".crewon-rollout-writer-generation.lock").open("a+b")
lock_mode = fcntl.LOCK_EX if mode == "legacy" else fcntl.LOCK_SH
try:
    fcntl.flock(lock_file.fileno(), lock_mode | fcntl.LOCK_NB)
except BlockingIOError:
    if "mutating" in Path(sys.argv[0]).name:
        lock_file.seek(0)
        lock_file.write(b"mutated-existing-file")
        lock_file.flush()
        os.fsync(lock_file.fileno())
    child_match = re.search(r"child-([0-9]+)", Path(sys.argv[0]).name)
    if child_match:
        child_listener = socket.socket()
        child_listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        child_listener.bind(("127.0.0.1", int(child_match.group(1))))
        child_listener.listen(1)
        child_pid = os.fork()
        if child_pid == 0:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            while True:
                time.sleep(1)
        child_listener.close()
    print("CREWON_HOME is owned by an incompatible rollout writer generation", file=sys.stderr, flush=True)
    raise SystemExit(1)

sqlite_home = Path(os.environ["CODEX_SQLITE_HOME"])
sqlite_home.mkdir(parents=True, exist_ok=True)
(sqlite_home / "state.db").write_bytes(b"initialized")
listen = sys.argv[sys.argv.index("--listen") + 1]
port = int(listen.rsplit(":", 1)[1])
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", port))
listener.listen(1)
listener.settimeout(0.2)
actual_port = listener.getsockname()[1]
print(f"app-server websocket listening on ws://127.0.0.1:{actual_port}", file=sys.stderr, flush=True)

def exact(stream, size):
    data = b""
    while len(data) < size:
        chunk = stream.recv(size - len(data))
        if not chunk:
            raise EOFError
        data += chunk
    return data

connection = None
while running and connection is None:
    try:
        connection, _ = listener.accept()
    except socket.timeout:
        pass
if connection is not None:
    request = b""
    while b"\r\n\r\n" not in request:
        request += connection.recv(4096)
    headers = request.decode("iso-8859-1").split("\r\n")
    key = next(line.split(":", 1)[1].strip() for line in headers if line.lower().startswith("sec-websocket-key:"))
    accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    connection.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
    first, second = exact(connection, 2)
    length = second & 0x7f
    if length == 126:
        length = int.from_bytes(exact(connection, 2), "big")
    mask = exact(connection, 4)
    payload = exact(connection, length)
    payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    request_message = json.loads(payload)
    response = json.dumps({"id": request_message["id"], "result": {"userAgent": "fake"}}, separators=(",", ":")).encode()
    connection.sendall(bytes((0x81, len(response))) + response)
while running:
    time.sleep(0.05)
"""


class GenerationProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.lease = self.root / "lease-aware-app-server"
        self.legacy = self.root / "legacy-app-server"
        source = textwrap.dedent(FAKE_SERVER).replace("__PYTHON__", sys.executable)
        for binary in (self.lease, self.legacy):
            binary.write_text(source, encoding="utf-8")
            binary.chmod(0o755)

    def make_binary(self, name: str) -> Path:
        binary = self.root / name
        binary.write_bytes(self.legacy.read_bytes())
        binary.chmod(0o755)
        return binary

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_probe(
        self,
        probe_home: Path,
        timeout: str = "5",
        lease_binary: Path | None = None,
        legacy_binary: Path | None = None,
        environment: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                os.fspath(PROBE),
                "--lease-aware-binary",
                os.fspath(lease_binary or self.lease),
                "--legacy-binary",
                os.fspath(legacy_binary or self.legacy),
                "--crewon-home",
                os.fspath(probe_home),
                "--timeout-seconds",
                timeout,
            ],
            check=False,
            capture_output=True,
            env=environment,
            text=True,
            timeout=30,
        )

    def test_real_process_matrix_passes_without_manifest(self) -> None:
        probe_home = self.root / "probe-home"
        probe_home.mkdir()
        result = self.run_probe(probe_home)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(
            payload["cases"],
            [
                {
                    "case": "leaseAware+leaseAware",
                    "portsDistinct": True,
                    "result": "bothInitialized",
                },
                {
                    "case": "legacy+legacy",
                    "result": "conflictBeforeStateOrListener",
                },
                {
                    "case": "legacyOwner+leaseAwareContender",
                    "result": "conflictBeforeStateOrListener",
                },
                {
                    "case": "leaseAwareOwner+legacyContender",
                    "result": "conflictBeforeStateOrListener",
                },
            ],
        )
        self.assertEqual(payload["manifestTrusted"], False)
        self.assertEqual(list(probe_home.iterdir()), [])

    def test_candidate_process_does_not_inherit_host_secrets(self) -> None:
        probe_home = self.root / "probe-home"
        probe_home.mkdir()
        environment = os.environ.copy()
        environment.update(
            {
                "OPENAI_API_KEY": "openai-secret",
                "PROBE_TEST_SECRET": "probe-secret",
                "SERVICE_CREDENTIAL": "credential-secret",
                "ACCESS_TOKEN": "token-secret",
                "HTTPS_PROXY": "http://proxy.invalid",
            }
        )
        result = self.run_probe(probe_home, environment=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("probe inherited host secret", result.stderr)

    def test_safe_environment_is_an_explicit_allowlist(self) -> None:
        home = self.root / "safe-home"
        process_dir = self.root / "safe-process"
        sqlite_home = process_dir / "sqlite"
        with mock.patch.dict(
            os.environ,
            {
                "PATH": "/safe/bin",
                "LANG": "C.UTF-8",
                "LD_LIBRARY_PATH": "/safe/lib",
                "OPENAI_API_KEY": "openai-secret",
                "SERVICE_CREDENTIAL": "credential-secret",
                "ACCESS_TOKEN": "token-secret",
                "HTTPS_PROXY": "http://proxy.invalid",
            },
            clear=True,
        ):
            environment = PROBE_MODULE.safe_environment(home, sqlite_home, process_dir)
        self.assertEqual(environment["PATH"], "/safe/bin")
        self.assertEqual(environment["LANG"], "C.UTF-8")
        self.assertEqual(environment["LD_LIBRARY_PATH"], "/safe/lib")
        self.assertEqual(environment["HOME"], os.fspath(home))
        for name in (
            "OPENAI_API_KEY",
            "SERVICE_CREDENTIAL",
            "ACCESS_TOKEN",
            "HTTPS_PROXY",
        ):
            self.assertNotIn(name, environment)

    def test_detects_content_change_to_existing_shared_home_file(self) -> None:
        probe_home = self.root / "probe-home"
        probe_home.mkdir()
        mutating_legacy = self.make_binary("legacy-mutating-app-server")
        result = self.run_probe(probe_home, legacy_binary=mutating_legacy)
        self.assertEqual(result.returncode, 1)
        self.assertIn("mutated CREWON_HOME entries", result.stderr)
        self.assertIn(
            "changed=['.crewon-rollout-writer-generation.lock']", result.stderr
        )

    def test_snapshot_rejects_special_and_oversized_entries(self) -> None:
        shared_home = self.root / "shared-home"
        shared_home.mkdir()
        target = shared_home / "target"
        target.write_bytes(b"data")
        (shared_home / "link").symlink_to(target)
        with self.assertRaisesRegex(PROBE_MODULE.ProbeError, "contains special entry"):
            PROBE_MODULE.path_snapshot(shared_home)
        (shared_home / "link").unlink()
        with mock.patch.object(PROBE_MODULE, "MAX_SHARED_HOME_FILE_BYTES", 3):
            with self.assertRaisesRegex(
                PROBE_MODULE.ProbeError, "exceeds snapshot limit"
            ):
                PROBE_MODULE.path_snapshot(shared_home)

    def test_cleanup_reclaims_children_after_leader_exits(self) -> None:
        probe_home = self.root / "probe-home"
        probe_home.mkdir()
        child_port = PROBE_MODULE.reserve_port()
        legacy_with_child = self.make_binary(f"legacy-child-{child_port}-app-server")
        result = self.run_probe(probe_home, legacy_binary=legacy_with_child)
        self.assertEqual(result.returncode, 0, result.stderr)
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", child_port), timeout=0.2)

    def test_cleanup_fails_when_process_group_cannot_be_confirmed_gone(self) -> None:
        server = PROBE_MODULE.ManagedServer(
            self.lease,
            self.root / "home",
            self.root / "process",
            1.0,
        )
        process = mock.Mock()
        process.pid = 1001
        process.poll.return_value = 7
        process.wait.return_value = 7
        server.process = process
        server.process_group_id = 2002
        with (
            mock.patch.object(PROBE_MODULE, "process_group_exists", return_value=True),
            mock.patch.object(PROBE_MODULE.os, "killpg") as killpg,
            mock.patch.object(PROBE_MODULE, "PROCESS_GROUP_KILL_GRACE_SECONDS", 0.0),
        ):
            with self.assertRaisesRegex(
                PROBE_MODULE.ProbeError, "could not confirm process group"
            ):
                server.stop()
        killpg.assert_any_call(2002, signal.SIGTERM)
        killpg.assert_any_call(2002, signal.SIGKILL)

    def test_rejects_nonempty_probe_home(self) -> None:
        probe_home = self.root / "probe-home"
        probe_home.mkdir()
        (probe_home / "do-not-touch").write_text("user data", encoding="utf-8")
        result = self.run_probe(probe_home)
        self.assertEqual(result.returncode, 1)
        self.assertIn("probe root must be empty", result.stderr)
        self.assertEqual((probe_home / "do-not-touch").read_text(), "user data")

    def test_rejects_unbounded_timeout(self) -> None:
        probe_home = self.root / "probe-home"
        probe_home.mkdir()
        result = self.run_probe(probe_home, timeout="121")
        self.assertEqual(result.returncode, 1)
        self.assertIn("between 1 and 120", result.stderr)


if __name__ == "__main__":
    unittest.main()
