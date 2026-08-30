#!/usr/bin/env python3

import json
import os
from pathlib import Path
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import unittest


SCRIPT = Path(__file__).with_name("initialize-local-agent-platform.py")


class LoginHandler(BaseHTTPRequestHandler):
    response_status = 200
    response_body = {"access_token": "fixture-access-token"}
    received_path = ""
    received_body = b""

    def do_POST(self) -> None:
        type(self).received_path = self.path
        length = int(self.headers.get("content-length", "0"))
        type(self).received_body = self.rfile.read(length)
        body = json.dumps(type(self).response_body).encode("utf-8")
        self.send_response(type(self).response_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        pass


class InitializeLocalAgentPlatformTests(unittest.TestCase):
    def setUp(self) -> None:
        LoginHandler.response_status = 200
        LoginHandler.response_body = {"access_token": "fixture-access-token"}
        LoginHandler.received_path = ""
        LoginHandler.received_body = b""
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), LoginHandler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def invoke(self, *, origin: str | None = None) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.update(
            {
                "CREWON_AGENT_PLATFORM_BOOTSTRAP_USERNAME": "local-admin",
                "CREWON_AGENT_PLATFORM_BOOTSTRAP_PASSWORD": "local-password",
            }
        )
        host, port = self.server.server_address
        return subprocess.run(
            [
                sys.executable,
                os.fspath(SCRIPT),
                "--origin",
                origin or f"http://{host}:{port}",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
            env=environment,
        )

    def test_logs_in_without_exposing_credentials(self) -> None:
        completed = self.invoke()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(LoginHandler.received_path, "/api/v1/auth/login")
        self.assertEqual(
            LoginHandler.received_body,
            b"username=local-admin&password=local-password",
        )
        output = completed.stdout + completed.stderr
        self.assertNotIn("local-admin", output)
        self.assertNotIn("local-password", output)
        self.assertNotIn("fixture-access-token", output)

    def test_rejects_non_loopback_origin_before_sending_credentials(self) -> None:
        completed = self.invoke(origin="https://example.com")

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("explicit loopback origin", completed.stderr)
        self.assertEqual(LoginHandler.received_path, "")

    def test_fails_closed_on_invalid_login_response(self) -> None:
        LoginHandler.response_body = {"token": "wrong-field"}

        completed = self.invoke()

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("login response is invalid", completed.stderr)


if __name__ == "__main__":
    unittest.main()
