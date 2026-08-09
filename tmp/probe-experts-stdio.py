#!/usr/bin/env python3
"""Probe expertTeam/* over stdio to confirm the feature works off the WebSocket path."""

import json
import subprocess
import sys

BIN = "./codex-rs/target/debug/crewon-app-server"
CWD = "/Users/wangqichen/projects/brilliant/cuican-aide"


def send(proc, request_id, method, params):
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            return {"error": "eof"}
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("id") == request_id:
            return message


def main() -> None:
    proc = subprocess.Popen(
        [BIN, "--listen", "stdio://"],
        cwd=CWD,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        env={
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": "/Users/wangqichen",
            "CREWON_HOME": f"{CWD}/.crewon",
            "CREWON_APP_SERVER_DISABLE_MANAGED_CONFIG": "1",
        },
    )
    try:
        print("initialize:", json.dumps(send(proc, 1, "initialize", {
            "clientInfo": {"name": "probe", "title": "probe", "version": "0.0.0"},
            "capabilities": {"experimentalApi": True},
        }), ensure_ascii=False)[:200])

        listed = send(proc, 2, "workspace/list", {"cursor": None, "limit": 20})
        print("workspace/list:", json.dumps(listed, ensure_ascii=False)[:700])

        keys = [
            entry.get("workspaceKey")
            for entry in (listed.get("result") or {}).get("data", [])
            if isinstance(entry, dict)
        ]
        for key in keys:
            result = send(
                proc, 10, "expertTeam/list", {"workspaceKey": key, "cursor": None, "limit": 100}
            )
            print(f"expertTeam/list[{key}]:", json.dumps(result, ensure_ascii=False)[:600])
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
