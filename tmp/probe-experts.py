#!/usr/bin/env python3
"""Probe expertTeam/* over the app-server WebSocket to capture the real error.

Run with the dev app-server listening on ws://127.0.0.1:6176.
"""

import json
import sys

from websockets.sync.client import connect

URL = "ws://127.0.0.1:6176"
CWD = "/Users/wangqichen/projects/brilliant/cuican-aide"


def rpc(ws, request_id, method, params):
    ws.send(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}))
    while True:
        message = json.loads(ws.recv())
        if message.get("id") == request_id:
            return message


def main() -> None:
    with connect(URL, max_size=8 * 1024 * 1024) as ws:
        init = rpc(
            ws,
            1,
            "initialize",
            {"clientInfo": {"name": "probe", "title": "probe", "version": "0.0.0"}},
        )
        print("initialize:", json.dumps(init, ensure_ascii=False)[:400])

        bind = rpc(ws, 2, "workspace/bind", {"cwd": CWD})
        print("workspace/bind:", json.dumps(bind, ensure_ascii=False)[:600])

        workspace_key = ""
        result = bind.get("result") or {}
        workspace = result.get("workspace") or result
        if isinstance(workspace, dict):
            workspace_key = workspace.get("workspaceKey", "")
        print("workspaceKey:", workspace_key)

        listing = rpc(
            ws,
            3,
            "expertTeam/list",
            {"workspaceKey": workspace_key, "cursor": None, "limit": 100},
        )
        print("expertTeam/list:", json.dumps(listing, ensure_ascii=False)[:800])


if __name__ == "__main__":
    sys.exit(main())
