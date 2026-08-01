#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
from typing import Any

from websockets.sync.client import connect


RESERVED_SOURCE = "crewon_cloud_agent_provider_binding_v1"
READ_ONLY_MESSAGE = "Cloud Agent Thread is read-only in this compatibility version"
CREATE_BLOCK_MESSAGE = "this compatibility version cannot create Cloud Agent Threads"


class RpcClient:
    def __init__(self, url: str) -> None:
        self._socket = connect(url, open_timeout=10, close_timeout=5)
        self._next_id = 1

    def close(self) -> None:
        self._socket.close()

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._socket.send(json.dumps({"method": method, "params": params}))

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        self._socket.send(
            json.dumps({"id": request_id, "method": method, "params": params})
        )
        deadline = time.monotonic() + 20
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"timed out waiting for {method}")
            message = json.loads(self._socket.recv(timeout=remaining))
            if message.get("id") == request_id:
                return message

    def initialize(self) -> None:
        response = self.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "w3-01-fence-artifact-harness",
                    "title": "W3-01 Fence Artifact Harness",
                    "version": "1.0.0",
                },
                "capabilities": {"experimentalApi": True},
            },
        )
        require_success(response, "initialize")
        self.notify("initialized")


class AppServerProcess:
    def __init__(self, binary: Path, home: Path, cwd: Path) -> None:
        self._binary = binary
        self._home = home
        self._cwd = cwd
        self._port = reserve_port()
        self.url = f"ws://127.0.0.1:{self._port}"
        self._stdout = home / "app-server.stdout.log"
        self._stderr = home / "app-server.stderr.log"
        self._process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        environment = os.environ.copy()
        environment.update(
            {
                "CREWON_HOME": str(self._home),
                "CODEX_HOME": str(self._home),
                "CODEX_SQLITE_HOME": str(self._home),
                "CREWON_APP_SERVER_DISABLE_MANAGED_CONFIG": "1",
                "CREWON_APP_SERVER_MANAGED_CONFIG_PATH": str(
                    self._home / "managed_config.toml"
                ),
                "RUST_LOG": "warn",
            }
        )
        for key in list(environment):
            if key in {"OPENAI_API_KEY", "AICUICAN_API_KEY"} or key.startswith(
                "CREWON_PROVIDER_"
            ):
                environment.pop(key, None)

        stdout = self._stdout.open("ab")
        stderr = self._stderr.open("ab")
        self._process = subprocess.Popen(
            [
                str(self._binary),
                "--listen",
                self.url,
                "--disable-plugin-startup-tasks-for-tests",
            ],
            cwd=self._cwd,
            env=environment,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
        )
        stdout.close()
        stderr.close()
        wait_for_port(self._port, self._process, self._stderr)

    def stop(self) -> None:
        if self._process is None or self._process.poll() is not None:
            return
        os.killpg(self._process.pid, signal.SIGTERM)
        try:
            self._process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(self._process.pid, signal.SIGKILL)
            self._process.wait(timeout=5)


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind(("127.0.0.1", 0))
        return int(candidate.getsockname()[1])


def wait_for_port(port: int, process: subprocess.Popen[bytes], stderr: Path) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            error = stderr.read_text(errors="replace")[-4000:]
            raise RuntimeError(f"app-server exited before ready:\n{error}")
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.2)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise TimeoutError(f"app-server did not listen on port {port}")


def require_success(response: dict[str, Any], method: str) -> Any:
    if "error" in response:
        raise AssertionError(f"{method} unexpectedly failed: {response['error']}")
    if "result" not in response:
        raise AssertionError(f"{method} returned no result")
    return response["result"]


def require_error(
    response: dict[str, Any],
    method: str,
    expected_message: str,
) -> dict[str, Any]:
    error = response.get("error")
    if not isinstance(error, dict):
        raise AssertionError(f"{method} unexpectedly succeeded")
    message = str(error.get("message", ""))
    if expected_message not in message:
        raise AssertionError(f"{method} returned unexpected error: {error}")
    return {"code": error.get("code"), "message": message}


def thread_id_from_start(response: dict[str, Any]) -> str:
    result = require_success(response, "thread/start")
    thread = result.get("thread") if isinstance(result, dict) else None
    thread_id = thread.get("id") if isinstance(thread, dict) else None
    if not isinstance(thread_id, str) or not thread_id:
        raise AssertionError("thread/start returned no thread id")
    return thread_id


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rollout_paths_from_state(home: Path, thread_id: str) -> list[Path]:
    paths: list[Path] = []
    for database in sorted(home.glob("state_*.sqlite")):
        with sqlite3.connect(database) as connection:
            table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'"
            ).fetchone()
            if table is None:
                continue
            rows = connection.execute(
                "SELECT rollout_path FROM threads WHERE id = ?",
                (thread_id,),
            ).fetchall()
            paths.extend(Path(str(row[0])) for row in rows)
    return paths


def replace_rollout_source(home: Path, thread_id: str) -> Path:
    deadline = time.monotonic() + 10
    candidates: list[Path] = []
    while time.monotonic() < deadline:
        candidates = rollout_paths_from_state(home, thread_id)
        candidates.extend(sorted(home.rglob("*.jsonl")))
        candidates = list(dict.fromkeys(candidates))
        if any(candidate.is_file() for candidate in candidates):
            break
        time.sleep(0.1)

    for rollout in candidates:
        if not rollout.is_file():
            continue
        lines = rollout.read_text().splitlines()
        if not lines:
            continue
        first = json.loads(lines[0])
        payload = first.get("payload")
        if first.get("type") != "session_meta" or not isinstance(payload, dict):
            continue
        if payload.get("id") != thread_id:
            continue
        payload["thread_source"] = RESERVED_SOURCE
        lines[0] = json.dumps(first, ensure_ascii=False, separators=(",", ":"))
        replacement = rollout.with_suffix(".jsonl.tmp")
        replacement.write_text("\n".join(lines) + "\n")
        os.replace(replacement, rollout)
        return rollout
    observed = ", ".join(str(path) for path in candidates) or "none"
    raise AssertionError(
        f"rollout for {thread_id} was not found; candidates: {observed}"
    )


def replace_state_source(home: Path, thread_id: str) -> int:
    updated = 0
    for database in sorted(home.glob("state_*.sqlite")):
        with sqlite3.connect(database) as connection:
            table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'"
            ).fetchone()
            if table is None:
                continue
            cursor = connection.execute(
                "UPDATE threads SET thread_source = ?, has_user_event = 1, "
                "preview = ?, first_user_message = ? WHERE id = ?",
                (
                    RESERVED_SOURCE,
                    "future cutover fixture",
                    "future cutover fixture",
                    thread_id,
                ),
            )
            updated += cursor.rowcount
    if updated != 1:
        raise AssertionError(f"expected one State thread update, got {updated}")
    return updated


def state_thread_diagnostic(home: Path, thread_id: str) -> dict[str, Any]:
    for database in sorted(home.glob("state_*.sqlite")):
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                "SELECT id, source, model_provider, cwd, archived, has_user_event, "
                "thread_source, rollout_path FROM threads WHERE id = ?",
                (thread_id,),
            ).fetchone()
            if row is not None:
                return dict(row)
    return {}


def assert_thread_visible(
    client: RpcClient,
    thread_id: str,
    state_diagnostic: dict[str, Any],
) -> None:
    read = require_success(
        client.request("thread/read", {"threadId": thread_id, "includeTurns": True}),
        "thread/read",
    )
    if read.get("thread", {}).get("id") != thread_id:
        raise AssertionError("thread/read did not return the reserved thread")

    listed = require_success(
        client.request(
            "thread/list",
            {
                "limit": 20,
                "sortKey": "updated_at",
                "sortDirection": "desc",
                "modelProviders": [],
                "useStateDbOnly": True,
            },
        ),
        "thread/list",
    )
    if thread_id not in {
        thread.get("id")
        for thread in listed.get("data", [])
        if isinstance(thread, dict)
    }:
        raise AssertionError(
            "thread/list did not return the reserved thread: "
            + json.dumps(
                {"response": listed, "state": state_diagnostic}, ensure_ascii=False
            )
        )


def exercise_fence(
    client: RpcClient,
    thread_id: str,
    state_diagnostic: dict[str, Any],
) -> dict[str, Any]:
    assert_thread_visible(client, thread_id, state_diagnostic)
    require_success(
        client.request(
            "thread/name/set",
            {"threadId": thread_id, "name": "rollback-readable-cloud-thread"},
        ),
        "thread/name/set",
    )
    require_success(
        client.request("thread/resume", {"threadId": thread_id}),
        "thread/resume",
    )

    blocked = {
        "turn/start": require_error(
            client.request(
                "turn/start",
                {
                    "threadId": thread_id,
                    "clientUserMessageId": "rollback-fence-turn",
                    "input": [
                        {
                            "type": "text",
                            "text": "must stay read-only",
                            "text_elements": [],
                        }
                    ],
                },
            ),
            "turn/start",
            READ_ONLY_MESSAGE,
        ),
        "thread/fork": require_error(
            client.request("thread/fork", {"threadId": thread_id}),
            "thread/fork",
            READ_ONLY_MESSAGE,
        ),
        "thread/delete": require_error(
            client.request("thread/delete", {"threadId": thread_id}),
            "thread/delete",
            READ_ONLY_MESSAGE,
        ),
        "thread/archive": require_error(
            client.request("thread/archive", {"threadId": thread_id}),
            "thread/archive",
            READ_ONLY_MESSAGE,
        ),
        "thread/unarchive": require_error(
            client.request("thread/unarchive", {"threadId": thread_id}),
            "thread/unarchive",
            READ_ONLY_MESSAGE,
        ),
    }
    return {
        "read": "allowed",
        "nonMovingMetadata": "allowed",
        "fileMovingLifecycle": "blocked",
        "blocked": blocked,
    }


def run(binary: Path, repo_root: Path) -> dict[str, Any]:
    binary = binary.resolve(strict=True)
    repo_root = repo_root.resolve(strict=True)
    digest = sha256_file(binary)

    with tempfile.TemporaryDirectory(prefix="crewon-w3-01-fence-") as temp:
        home = Path(temp).resolve() / "home"
        home.mkdir()
        process = AppServerProcess(binary, home, repo_root)
        try:
            process.start()
            client = RpcClient(process.url)
            try:
                client.initialize()
                creation_error = require_error(
                    client.request(
                        "thread/start",
                        {"cwd": str(repo_root), "threadSource": RESERVED_SOURCE},
                    ),
                    "thread/start reserved source",
                    CREATE_BLOCK_MESSAGE,
                )
                thread_id = thread_id_from_start(
                    client.request(
                        "thread/start",
                        {"cwd": str(repo_root), "threadSource": "user"},
                    )
                )
                require_success(
                    client.request(
                        "thread/inject_items",
                        {
                            "threadId": thread_id,
                            "items": [
                                {
                                    "type": "message",
                                    "role": "user",
                                    "content": [
                                        {
                                            "type": "input_text",
                                            "text": "future cutover fixture",
                                        }
                                    ],
                                }
                            ],
                        },
                    ),
                    "thread/inject_items fixture",
                )
            finally:
                client.close()
        finally:
            process.stop()

        rollout = replace_rollout_source(home, thread_id)
        state_updates = replace_state_source(home, thread_id)

        deployed = AppServerProcess(binary, home, repo_root)
        try:
            deployed.start()
            replace_state_source(home, thread_id)
            state_diagnostic = state_thread_diagnostic(home, thread_id)
            client = RpcClient(deployed.url)
            try:
                client.initialize()
                deployment_result = exercise_fence(client, thread_id, state_diagnostic)
                ordinary_thread_id = thread_id_from_start(
                    client.request(
                        "thread/start",
                        {"cwd": str(repo_root), "threadSource": "user"},
                    )
                )
                require_success(
                    client.request("thread/delete", {"threadId": ordinary_thread_id}),
                    "ordinary thread/delete",
                )
            finally:
                client.close()
        finally:
            deployed.stop()

        rolled_back = AppServerProcess(binary, home, repo_root)
        try:
            rolled_back.start()
            replace_state_source(home, thread_id)
            state_diagnostic = state_thread_diagnostic(home, thread_id)
            client = RpcClient(rolled_back.url)
            try:
                client.initialize()
                rollback_result = exercise_fence(client, thread_id, state_diagnostic)
            finally:
                client.close()
        finally:
            rolled_back.stop()

        return {
            "status": "green",
            "artifact": {"path": str(binary), "sha256": digest},
            "reservedSource": RESERVED_SOURCE,
            "creationFence": creation_error,
            "fixture": {
                "threadId": thread_id,
                "rollout": str(rollout.relative_to(home)),
                "stateRowsUpdated": state_updates,
            },
            "deployment": deployment_result,
            "ordinaryThread": {"createAndDelete": "allowed"},
            "rollback": rollback_result,
        }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify a W3-01 compatibility fence app-server artifact."
    )
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--repo-root", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(run(args.binary, args.repo_root), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
