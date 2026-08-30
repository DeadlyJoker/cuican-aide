#!/usr/bin/env python3
"""Check whether stdio hands out a stable workspaceKey across restarts.

Expert Team records are keyed by workspaceKey, so an unstable key orphans every
record even on the desktop transport.
"""

import json
import subprocess

BIN = "./codex-rs/target/debug/crewon-app-server"
CWD = "/Users/wangqichen/projects/brilliant/cuican-aide"
ENV = {
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    "HOME": "/Users/wangqichen",
    "CREWON_HOME": f"{CWD}/.crewon",
    "CREWON_APP_SERVER_DISABLE_MANAGED_CONFIG": "1",
}


def send(proc, request_id, method, params):
    proc.stdin.write(
        json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n"
    )
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            return {}
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("id") == request_id:
            return message


def workspace_keys():
    proc = subprocess.Popen(
        [BIN, "--listen", "stdio://"],
        cwd=CWD,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        env=ENV,
    )
    try:
        send(
            proc,
            1,
            "initialize",
            {
                "clientInfo": {"name": "probe", "title": "probe", "version": "0.0.0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        listed = send(proc, 2, "workspace/list", {"cursor": None, "limit": 20})
        result = listed.get("result") or {}
        return [
            entry.get("workspaceKey")
            for entry in result.get("data", [])
            if isinstance(entry, dict)
        ]
    finally:
        proc.terminate()
        proc.wait(timeout=10)


for attempt in range(2):
    print(f"stdio run {attempt + 1}:", workspace_keys())
