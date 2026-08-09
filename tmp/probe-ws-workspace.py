#!/usr/bin/env python3
"""Check whether the WebSocket transport hands out a stable workspaceKey.

Expert Team records are scoped by workspaceKey, so a per-connection key would
orphan every record on reconnect.
"""

import json

from websockets.sync.client import connect

URL = "ws://127.0.0.1:6176"


def rpc(ws, request_id, method, params):
    ws.send(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}))
    while True:
        message = json.loads(ws.recv())
        if message.get("id") == request_id:
            return message


def workspace_keys():
    with connect(URL, max_size=8 * 1024 * 1024) as ws:
        rpc(
            ws,
            1,
            "initialize",
            {
                "clientInfo": {"name": "probe", "title": "probe", "version": "0.0.0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        listed = rpc(ws, 2, "workspace/list", {"cursor": None, "limit": 20})
        result = listed.get("result") or {}
        return result.get("accessMode"), [
            entry.get("workspaceKey")
            for entry in result.get("data", [])
            if isinstance(entry, dict)
        ], listed.get("error")


for attempt in range(2):
    print(f"connection {attempt + 1}:", workspace_keys())
