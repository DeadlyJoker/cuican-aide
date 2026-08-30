#!/usr/bin/env python3

"""Black-box probe for app-server rollout-writer generation behavior.

The probe executes the supplied binaries directly and never trusts artifact
manifests or self-reported generation labels. It is Unix-only because the
conflict checks suspend the initialized owner process group while preserving
its file locks.
"""

import argparse
import base64
from collections import deque
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import secrets
import signal
import socket
import stat
import subprocess
import tempfile
import threading
import time
from typing import Any


MAX_FRAME_BYTES = 1024 * 1024
MAX_HEADER_BYTES = 64 * 1024
MAX_SHARED_HOME_ENTRIES = 4096
MAX_SHARED_HOME_FILE_BYTES = 10 * 1024 * 1024
MAX_SHARED_HOME_TOTAL_BYTES = 64 * 1024 * 1024
MAX_SHARED_HOME_DEPTH = 64
PROCESS_GROUP_TERM_GRACE_SECONDS = 0.5
PROCESS_GROUP_KILL_GRACE_SECONDS = 1.0
CONFLICT_TEXT = "incompatible rollout writer generation"
LISTEN_PATTERN = re.compile(r"ws://(?:127\.0\.0\.1|\[::1\]):([0-9]+)")
INHERITED_ENVIRONMENT_NAMES = (
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "DYLD_FALLBACK_FRAMEWORK_PATH",
)


class ProbeError(Exception):
    pass


def remaining(deadline: float, label: str) -> float:
    value = deadline - time.monotonic()
    if value <= 0:
        raise ProbeError(f"timed out while {label}")
    return value


def receive_exact(stream: socket.socket, size: int, deadline: float) -> bytes:
    chunks: list[bytes] = []
    received = 0
    while received < size:
        stream.settimeout(remaining(deadline, "reading websocket data"))
        chunk = stream.recv(size - received)
        if not chunk:
            raise ProbeError("websocket closed unexpectedly")
        chunks.append(chunk)
        received += len(chunk)
    return b"".join(chunks)


class WebSocketClient:
    def __init__(self, port: int, timeout_seconds: float):
        self._timeout_seconds = timeout_seconds
        self._stream = socket.create_connection(("127.0.0.1", port), timeout_seconds)
        self._handshake(port)

    def _handshake(self, port: int) -> None:
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        request = (
            "GET / HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii")
        self._stream.sendall(request)
        deadline = time.monotonic() + self._timeout_seconds
        response = bytearray()
        while b"\r\n\r\n" not in response:
            if len(response) >= MAX_HEADER_BYTES:
                raise ProbeError("websocket handshake response exceeded limit")
            response.extend(receive_exact(self._stream, 1, deadline))
        head = response.decode("iso-8859-1")
        lines = head.split("\r\n")
        if not lines or " 101 " not in lines[0]:
            raise ProbeError(
                f"websocket handshake was rejected: {lines[0] if lines else head}"
            )
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.lower()] = value.strip()
        expected = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
            ).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != expected:
            raise ProbeError("websocket handshake returned an invalid accept key")

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if len(payload) > MAX_FRAME_BYTES:
            raise ProbeError("outbound websocket frame exceeded limit")
        first = 0x80 | opcode
        mask = secrets.token_bytes(4)
        length = len(payload)
        if length < 126:
            header = bytes((first, 0x80 | length))
        elif length <= 0xFFFF:
            header = bytes((first, 0x80 | 126)) + length.to_bytes(2, "big")
        else:
            header = bytes((first, 0x80 | 127)) + length.to_bytes(8, "big")
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self._stream.sendall(header + mask + masked)

    def send_json(self, value: dict[str, Any]) -> None:
        self._send_frame(0x1, json.dumps(value, separators=(",", ":")).encode("utf-8"))

    def receive_json(self, request_id: int) -> dict[str, Any]:
        deadline = time.monotonic() + self._timeout_seconds
        fragments = bytearray()
        fragment_opcode: int | None = None
        while True:
            first, second = receive_exact(self._stream, 2, deadline)
            final = bool(first & 0x80)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = int.from_bytes(receive_exact(self._stream, 2, deadline), "big")
            elif length == 127:
                length = int.from_bytes(receive_exact(self._stream, 8, deadline), "big")
            if length > MAX_FRAME_BYTES:
                raise ProbeError("inbound websocket frame exceeded limit")
            mask = receive_exact(self._stream, 4, deadline) if masked else b""
            payload = receive_exact(self._stream, length, deadline)
            if masked:
                payload = bytes(
                    value ^ mask[index % 4] for index, value in enumerate(payload)
                )
            if opcode == 0x8:
                raise ProbeError("websocket closed before initialize completed")
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                fragments = bytearray(payload)
                fragment_opcode = opcode
            elif opcode == 0x0 and fragment_opcode is not None:
                fragments.extend(payload)
            else:
                raise ProbeError(f"unexpected websocket opcode {opcode}")
            if not final:
                continue
            if fragment_opcode != 0x1:
                raise ProbeError("initialize response was not a text frame")
            try:
                message = json.loads(fragments.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ProbeError(f"invalid JSON websocket response: {error}") from error
            fragments = bytearray()
            fragment_opcode = None
            if isinstance(message, dict) and message.get("id") == request_id:
                return message

    def initialize(self) -> None:
        self.send_json(
            {
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "generation-probe",
                        "title": "App-server generation probe",
                        "version": "1.0.0",
                    }
                },
            }
        )
        response = self.receive_json(1)
        if "error" in response or "result" not in response:
            raise ProbeError(f"initialize failed: {response}")
        self.send_json({"method": "initialized"})

    def close(self) -> None:
        try:
            self._send_frame(0x8, b"")
        except OSError:
            pass
        self._stream.close()


def safe_environment(
    home: Path, sqlite_home: Path, process_dir: Path
) -> dict[str, str]:
    environment = {
        name: os.environ[name]
        for name in INHERITED_ENVIRONMENT_NAMES
        if name in os.environ
    }
    environment.update(
        {
            "HOME": os.fspath(home),
            "CREWON_HOME": os.fspath(home),
            "CODEX_HOME": os.fspath(home),
            "CODEX_SQLITE_HOME": os.fspath(sqlite_home),
            "XDG_CACHE_HOME": os.fspath(process_dir / "xdg-cache"),
            "XDG_CONFIG_HOME": os.fspath(process_dir / "xdg-config"),
            "XDG_DATA_HOME": os.fspath(process_dir / "xdg-data"),
            "TMPDIR": os.fspath(process_dir / "tmp"),
            "RUST_LOG": "warn",
            "RUST_BACKTRACE": "0",
            "CREWON_APP_SERVER_DISABLE_MANAGED_CONFIG": "1",
        }
    )
    for directory in (
        sqlite_home,
        process_dir / "xdg-cache",
        process_dir / "xdg-config",
        process_dir / "xdg-data",
        process_dir / "tmp",
    ):
        directory.mkdir(parents=True, exist_ok=True)
    return environment


class ManagedServer:
    def __init__(
        self,
        binary: Path,
        home: Path,
        process_dir: Path,
        timeout_seconds: float,
        listen_port: int = 0,
    ):
        self.binary = binary
        self.home = home
        self.process_dir = process_dir
        self.sqlite_home = process_dir / "sqlite"
        self.timeout_seconds = timeout_seconds
        self.listen_port = listen_port
        self.process: subprocess.Popen[str] | None = None
        self.client: WebSocketClient | None = None
        self.stderr_lines: deque[str] = deque(maxlen=200)
        self._stderr_queue: queue.Queue[str | None] = queue.Queue(maxsize=256)
        self._queue_startup_lines = False
        self._stderr_done = threading.Event()
        self._paused = False
        self.process_group_id: int | None = None

    def spawn(self, *, queue_startup_lines: bool) -> None:
        environment = safe_environment(self.home, self.sqlite_home, self.process_dir)
        self._queue_startup_lines = queue_startup_lines
        self.process = subprocess.Popen(
            [
                os.fspath(self.binary),
                "--listen",
                f"ws://127.0.0.1:{self.listen_port}",
                "--disable-plugin-startup-tasks-for-tests",
            ],
            cwd=self.process_dir,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=True,
        )
        self.process_group_id = self.process.pid
        assert self.process.stderr is not None

        def drain() -> None:
            assert self.process is not None and self.process.stderr is not None
            for line in self.process.stderr:
                value = line.rstrip("\n")
                self.stderr_lines.append(value)
                if self._queue_startup_lines:
                    self._stderr_queue.put(value)
            if self._queue_startup_lines:
                self._stderr_queue.put(None)
            self._stderr_done.set()

        threading.Thread(target=drain, daemon=True).start()

    def start_and_initialize(self) -> int:
        self.spawn(queue_startup_lines=True)
        assert self.process is not None
        deadline = time.monotonic() + self.timeout_seconds
        port: int | None = None
        while port is None:
            item = self._stderr_queue.get(
                timeout=remaining(deadline, "waiting for app-server listener")
            )
            if item is None:
                raise ProbeError(
                    f"app-server exited before listening: {self.stderr_text()}"
                )
            match = LISTEN_PATTERN.search(item)
            if match:
                port = int(match.group(1))
        self._queue_startup_lines = False
        self.client = WebSocketClient(port, remaining(deadline, "connecting websocket"))
        self.client.initialize()
        if self.process.poll() is not None:
            raise ProbeError(
                f"app-server exited after initialize: {self.stderr_text()}"
            )
        return port

    def pause(self) -> None:
        assert self.process is not None
        if self.process.poll() is not None:
            raise ProbeError("cannot pause an exited app-server")
        os.killpg(self.process.pid, signal.SIGSTOP)
        self._paused = True

    def wait_for_conflict(self) -> str:
        self.spawn(queue_startup_lines=False)
        assert self.process is not None
        try:
            return_code = self.process.wait(timeout=self.timeout_seconds)
        except subprocess.TimeoutExpired as error:
            raise ProbeError(
                "conflicting app-server did not fail within timeout"
            ) from error
        self._stderr_done.wait(timeout=min(self.timeout_seconds, 1.0))
        stderr = self.stderr_text()
        if return_code == 0:
            raise ProbeError("conflicting app-server exited successfully")
        if CONFLICT_TEXT not in stderr:
            raise ProbeError(
                f"conflicting app-server failed for another reason: {stderr}"
            )
        if LISTEN_PATTERN.search(stderr):
            raise ProbeError("conflicting app-server opened a listener before failing")
        return stderr

    def stderr_text(self) -> str:
        return "\n".join(self.stderr_lines)

    def stop(self) -> None:
        if self.client is not None:
            self.client.close()
            self.client = None
        if self.process is None or self.process_group_id is None:
            return
        process_group_id = self.process_group_id
        if self._paused:
            try:
                os.killpg(process_group_id, signal.SIGCONT)
            except ProcessLookupError:
                pass
            self._paused = False
        self.process.poll()
        if not process_group_exists(process_group_id):
            return
        signal_process_group(process_group_id, signal.SIGTERM)
        try:
            self.process.wait(timeout=PROCESS_GROUP_TERM_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        if process_group_exists(process_group_id):
            signal_process_group(process_group_id, signal.SIGKILL)
        try:
            self.process.wait(timeout=PROCESS_GROUP_KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        if not wait_for_process_group_exit(
            process_group_id, PROCESS_GROUP_KILL_GRACE_SECONDS
        ):
            raise ProbeError(
                f"could not confirm process group {process_group_id} was reclaimed"
            )


def signal_process_group(process_group_id: int, signal_value: signal.Signals) -> None:
    try:
        os.killpg(process_group_id, signal_value)
    except ProcessLookupError:
        pass


def process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError as error:
        raise ProbeError(
            f"cannot verify process group {process_group_id} ownership"
        ) from error
    return True


def wait_for_process_group_exit(process_group_id: int, timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while process_group_exists(process_group_id):
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.02)
    return True


def stop_managed_servers(*servers: ManagedServer) -> None:
    failures: list[str] = []
    for server in servers:
        try:
            server.stop()
        except (OSError, ProbeError) as error:
            failures.append(str(error))
    if failures:
        raise ProbeError(f"app-server cleanup failed: {'; '.join(failures)}")


@dataclass(frozen=True)
class SnapshotEntry:
    entry_type: str
    inode: int
    size: int
    modified_at_ns: int
    changed_at_ns: int
    sha256: str | None


def snapshot_entry_from_stat(
    metadata: os.stat_result, entry_type: str, sha256: str | None
) -> SnapshotEntry:
    return SnapshotEntry(
        entry_type=entry_type,
        inode=metadata.st_ino,
        size=metadata.st_size,
        modified_at_ns=metadata.st_mtime_ns,
        changed_at_ns=metadata.st_ctime_ns,
        sha256=sha256,
    )


def same_snapshot_metadata(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        stat.S_IFMT(left.st_mode),
        left.st_ino,
        left.st_size,
        left.st_mtime_ns,
        left.st_ctime_ns,
    ) == (
        stat.S_IFMT(right.st_mode),
        right.st_ino,
        right.st_size,
        right.st_mtime_ns,
        right.st_ctime_ns,
    )


def file_snapshot(path: Path, initial: os.stat_result) -> tuple[SnapshotEntry, int]:
    if initial.st_size > MAX_SHARED_HOME_FILE_BYTES:
        raise ProbeError(f"shared CREWON_HOME file exceeds snapshot limit: {path}")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or not same_snapshot_metadata(
            initial, opened
        ):
            raise ProbeError(f"shared CREWON_HOME changed while scanning: {path}")
        digest = hashlib.sha256()
        bytes_read = 0
        while chunk := os.read(descriptor, 1024 * 1024):
            bytes_read += len(chunk)
            if bytes_read > MAX_SHARED_HOME_FILE_BYTES:
                raise ProbeError(
                    f"shared CREWON_HOME file exceeds snapshot limit: {path}"
                )
            digest.update(chunk)
        finished = os.fstat(descriptor)
        if bytes_read != opened.st_size or not same_snapshot_metadata(opened, finished):
            raise ProbeError(f"shared CREWON_HOME changed while scanning: {path}")
    finally:
        os.close(descriptor)
    final = path.lstat()
    if not same_snapshot_metadata(finished, final):
        raise ProbeError(f"shared CREWON_HOME changed while scanning: {path}")
    return snapshot_entry_from_stat(final, "file", digest.hexdigest()), bytes_read


def path_snapshot(root: Path) -> dict[str, SnapshotEntry]:
    if not root.exists():
        return {}
    snapshot: dict[str, SnapshotEntry] = {}
    total_bytes = 0

    def scan(directory: Path, relative: Path, depth: int) -> None:
        nonlocal total_bytes
        if depth > MAX_SHARED_HOME_DEPTH:
            raise ProbeError("shared CREWON_HOME exceeded snapshot depth limit")
        initial = directory.lstat()
        if not stat.S_ISDIR(initial.st_mode):
            raise ProbeError(f"shared CREWON_HOME contains special entry: {directory}")
        key = "." if relative == Path(".") else relative.as_posix()
        snapshot[key] = snapshot_entry_from_stat(initial, "directory", None)
        try:
            children = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError as error:
            raise ProbeError(f"cannot scan shared CREWON_HOME: {directory}") from error
        for child in children:
            if len(snapshot) >= MAX_SHARED_HOME_ENTRIES:
                raise ProbeError("shared CREWON_HOME exceeded snapshot entry limit")
            path = Path(child.path)
            child_relative = relative / child.name
            metadata = path.lstat()
            if stat.S_ISDIR(metadata.st_mode):
                scan(path, child_relative, depth + 1)
            elif stat.S_ISREG(metadata.st_mode):
                entry, bytes_read = file_snapshot(path, metadata)
                total_bytes += bytes_read
                if total_bytes > MAX_SHARED_HOME_TOTAL_BYTES:
                    raise ProbeError(
                        "shared CREWON_HOME exceeded total snapshot byte limit"
                    )
                snapshot[child_relative.as_posix()] = entry
            else:
                raise ProbeError(f"shared CREWON_HOME contains special entry: {path}")
        final = directory.lstat()
        if not same_snapshot_metadata(initial, final):
            raise ProbeError(f"shared CREWON_HOME changed while scanning: {directory}")

    scan(root, Path("."), 0)
    return snapshot


def snapshot_changes(
    before: dict[str, SnapshotEntry], after: dict[str, SnapshotEntry]
) -> tuple[list[str], list[str], list[str]]:
    before_paths = set(before)
    after_paths = set(after)
    return (
        sorted(after_paths - before_paths),
        sorted(before_paths - after_paths),
        sorted(
            path for path in before_paths & after_paths if before[path] != after[path]
        ),
    )


def directory_is_empty(path: Path) -> bool:
    return not path.exists() or next(path.iterdir(), None) is None


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def assert_port_closed(port: int) -> None:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            pass
    except OSError:
        return
    raise ProbeError(f"conflicting app-server left listener 127.0.0.1:{port} open")


def probe_success_pair(
    root: Path, binary: Path, timeout_seconds: float
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="lease-pair-", dir=root) as case_value:
        case = Path(case_value)
        home = case / "home"
        home.mkdir()
        first = ManagedServer(binary, home, case / "first", timeout_seconds)
        second = ManagedServer(binary, home, case / "second", timeout_seconds)
        try:
            first_port = first.start_and_initialize()
            second_port = second.start_and_initialize()
            if first.process is None or second.process is None:
                raise ProbeError("lease-aware process tracking was not initialized")
            if first.process.poll() is not None or second.process.poll() is not None:
                raise ProbeError(
                    "lease-aware process exited while its peer initialized"
                )
            return {
                "case": "leaseAware+leaseAware",
                "result": "bothInitialized",
                "portsDistinct": first_port != second_port,
            }
        finally:
            stop_managed_servers(second, first)


def probe_conflict(
    root: Path,
    case_name: str,
    owner_binary: Path,
    contender_binary: Path,
    timeout_seconds: float,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="conflict-", dir=root) as case_value:
        case = Path(case_value)
        home = case / "home"
        home.mkdir()
        owner = ManagedServer(owner_binary, home, case / "owner", timeout_seconds)
        contender_port = reserve_port()
        contender = ManagedServer(
            contender_binary,
            home,
            case / "contender",
            timeout_seconds,
            listen_port=contender_port,
        )
        try:
            owner.start_and_initialize()
            owner.pause()
            before = path_snapshot(home)
            contender.wait_for_conflict()
            contender.stop()
            after = path_snapshot(home)
            if after != before:
                added, removed, changed = snapshot_changes(before, after)
                raise ProbeError(
                    "conflicting app-server mutated CREWON_HOME entries; "
                    f"added={added}, removed={removed}, changed={changed}"
                )
            if not directory_is_empty(contender.sqlite_home):
                raise ProbeError(
                    "conflicting app-server initialized its isolated state directory"
                )
            assert_port_closed(contender_port)
            return {
                "case": case_name,
                "result": "conflictBeforeStateOrListener",
            }
        finally:
            stop_managed_servers(contender, owner)


def validate_binary(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise ProbeError(f"{label} path must be absolute")
    if path.is_symlink() or not path.is_file():
        raise ProbeError(f"{label} must be a regular non-symlink file")
    if not os.access(path, os.X_OK):
        raise ProbeError(f"{label} must be executable")
    return path


def validate_probe_root(value: str) -> Path:
    input_path = Path(value)
    if input_path.is_symlink():
        raise ProbeError("CREWON_HOME probe root must not be a symlink")
    path = input_path
    if not path.is_absolute():
        raise ProbeError("CREWON_HOME probe root must be absolute")
    path = path.resolve()
    forbidden = {Path("/").resolve(), Path.home().resolve()}
    for name in ("HOME", "CREWON_HOME", "CODEX_HOME"):
        configured = os.environ.get(name)
        if configured:
            forbidden.add(Path(configured).expanduser().resolve())
    if path in forbidden:
        raise ProbeError("refusing to use a real or process home as the probe root")
    if not path.is_dir():
        raise ProbeError("CREWON_HOME probe root must be an existing directory")
    if next(path.iterdir(), None) is not None:
        raise ProbeError("CREWON_HOME probe root must be empty")
    return path


def binary_identity(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as artifact:
        while chunk := artifact.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return {"path": os.fspath(path), "sha256": digest.hexdigest(), "sizeBytes": size}


def run_probe(
    lease_binary: Path,
    legacy_binary: Path,
    root: Path,
    timeout_seconds: float,
) -> dict[str, Any]:
    cases = [probe_success_pair(root, lease_binary, timeout_seconds)]
    cases.append(
        probe_conflict(
            root,
            "legacy+legacy",
            legacy_binary,
            legacy_binary,
            timeout_seconds,
        )
    )
    cases.append(
        probe_conflict(
            root,
            "legacyOwner+leaseAwareContender",
            legacy_binary,
            lease_binary,
            timeout_seconds,
        )
    )
    cases.append(
        probe_conflict(
            root,
            "leaseAwareOwner+legacyContender",
            lease_binary,
            legacy_binary,
            timeout_seconds,
        )
    )
    return {
        "verified": True,
        "probe": "app-server-generation-black-box",
        "leaseAwareArtifact": binary_identity(lease_binary),
        "legacyArtifact": binary_identity(legacy_binary),
        "cases": cases,
        "manifestTrusted": False,
        "sideEffectBoundary": (
            "conflict emitted no listener banner, left its requested port closed, "
            "left the bounded type/inode/size/mtime/ctime/SHA256 snapshot of shared "
            "CREWON_HOME unchanged, and left its isolated CODEX_SQLITE_HOME empty "
            "while the initialized owner was SIGSTOP'ed"
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lease-aware-binary", required=True)
    parser.add_argument("--legacy-binary", required=True)
    parser.add_argument("--crewon-home", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    return parser


def main() -> int:
    if (
        os.name != "posix"
        or not hasattr(os, "killpg")
        or not hasattr(signal, "SIGSTOP")
    ):
        print(
            "generation probe requires Unix process groups and SIGSTOP",
            file=os.sys.stderr,
        )
        return 2
    args = build_parser().parse_args()
    try:
        if not 1.0 <= args.timeout_seconds <= 120.0:
            raise ProbeError("timeout-seconds must be between 1 and 120")
        result = run_probe(
            validate_binary(args.lease_aware_binary, "lease-aware binary"),
            validate_binary(args.legacy_binary, "legacy binary"),
            validate_probe_root(args.crewon_home),
            args.timeout_seconds,
        )
    except (OSError, ProbeError, queue.Empty) as error:
        print(f"generation probe failed: {error}", file=os.sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
