#!/usr/bin/env python3
"""Serve crewon-ui static build and proxy API requests to PIM.

The Vite dev-server proxies `/agent-platform-api` → PIM, but a production build
embeds `VITE_AGENT_PLATFORM_BASE_URL` directly. This server supports both:

- Static files from the build output directory.
- API proxy: strips `/agent-platform-api/`, `/api/v1/`, `/sso/` prefixes and
  forwards the cleaned path to PIM.
"""

import argparse
import http.server
import json
import os
import urllib.request
import urllib.error
from pathlib import Path

PIM_BASE_URL = os.getenv("PIM_BASE_URL", "http://123.56.172.85:3000")
PROXY_PREFIXES = ("/agent-platform-api/", "/api/v1/", "/sso/")


def strip_proxy_prefix(path: str) -> str | None:
    """Return the path with the first matching proxy prefix removed, or None."""
    for prefix in PROXY_PREFIXES:
        if path.startswith(prefix):
            return path[len(prefix) - 1 :]  # keep leading /
    return None


class CrewonDemoHandler(http.server.SimpleHTTPRequestHandler):
    def _proxy(self, method: str) -> None:
        stripped = strip_proxy_prefix(self.path)
        if not stripped:
            self.send_response(405)
            self.end_headers()
            return

        url = PIM_BASE_URL.rstrip("/") + stripped
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        req = urllib.request.Request(url, data=body, method=method)
        for header in ("authorization", "content-type", "accept", "x-pim-launch-token"):
            value = self.headers.get(header)
            if value:
                req.add_header(header, value)

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                self.send_response(resp.status)
                for key, value in resp.headers.items():
                    if key.lower() not in (
                        "transfer-encoding",
                        "connection",
                        "server",
                        "date",
                    ):
                        self.send_header(key, value)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "*")
                self.end_headers()
                content = resp.read()
                if content:
                    self.wfile.write(content)
        except urllib.error.HTTPError as exc:
            self.send_response(exc.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(exc.read())
        except Exception as exc:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "proxy_error", "message": str(exc)}).encode()
            )

    def do_GET(self):
        if strip_proxy_prefix(self.path):
            self._proxy("GET")
        else:
            super().do_GET()

    def do_POST(self):
        if strip_proxy_prefix(self.path):
            self._proxy("POST")
        else:
            super().do_POST()

    def do_PUT(self):
        if strip_proxy_prefix(self.path):
            self._proxy("PUT")
        else:
            super().do_PUT()

    def do_DELETE(self):
        if strip_proxy_prefix(self.path):
            self._proxy("DELETE")
        else:
            super().do_DELETE()

    def do_PATCH(self):
        if strip_proxy_prefix(self.path):
            self._proxy("PATCH")
        else:
            super().do_PATCH()

    def do_OPTIONS(self):
        if strip_proxy_prefix(self.path):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header(
                "Access-Control-Allow-Methods",
                "GET, POST, PUT, DELETE, PATCH, OPTIONS",
            )
            self.send_header("Access-Control-Allow-Headers", "*")
            self.end_headers()
        else:
            super().do_OPTIONS()

    def log_message(self, format, *args):
        print(f"{self.address_string()} - {format % args}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9040)
    parser.add_argument("--directory", default=None)
    args = parser.parse_args()

    dist = args.directory or str(
        Path(__file__).resolve().parent.parent / "apps" / "crewon-ui" / "dist"
    )
    if not os.path.isdir(dist):
        print(f"❌ dist directory not found: {dist}")
        print("   Run `cd apps/crewon-ui && npm run build` first.")
        raise SystemExit(1)

    handler = lambda *ha, **hk: CrewonDemoHandler(*ha, directory=dist, **hk)
    server = http.server.HTTPServer(("0.0.0.0", args.port), handler)
    print(f"🚀 CrewON demo server at http://0.0.0.0:{args.port}")
    print(f"   Static:  {dist}")
    print(f"   Proxy:   {PIM_BASE_URL}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 shutting down")
        server.server_close()


if __name__ == "__main__":
    main()
