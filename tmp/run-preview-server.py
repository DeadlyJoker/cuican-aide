#!/usr/bin/env python3
"""Serve the preview HTML on a fixed port, detached from the calling shell."""

import http.server
import os
import socketserver
import sys

ROOT = "/Users/wangqichen/projects/brilliant/cuican-aide/tmp/pdfs/preview"
PORT = 8913

if os.fork() > 0:
    print(f"serving {ROOT} on http://127.0.0.1:{PORT}")
    sys.exit(0)

os.setsid()
if os.fork() > 0:
    os._exit(0)

os.chdir(ROOT)
with open("/tmp/preview-server.log", "wb", buffering=0) as log:
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(
    ("127.0.0.1", PORT), http.server.SimpleHTTPRequestHandler
) as server:
    server.serve_forever()
