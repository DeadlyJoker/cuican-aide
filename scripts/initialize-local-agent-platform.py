#!/usr/bin/env python3

"""Initialize the local Agent Platform identity context through its public login API."""

import argparse
import json
import os
import sys
from urllib import error, parse, request


USERNAME_ENV = "CREWON_AGENT_PLATFORM_BOOTSTRAP_USERNAME"
PASSWORD_ENV = "CREWON_AGENT_PLATFORM_BOOTSTRAP_PASSWORD"
MAX_RESPONSE_BYTES = 64 * 1024


class BootstrapError(RuntimeError):
    pass


class NoRedirectHandler(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Initialize the local Agent Platform identity context.",
    )
    parser.add_argument("--origin", required=True)
    return parser.parse_args(argv)


def local_origin(value: str) -> str:
    try:
        parsed = parse.urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise BootstrapError("Agent Platform origin is invalid") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/")
    ):
        raise BootstrapError(
            "Agent Platform origin must be an explicit loopback origin"
        )
    return value.rstrip("/")


def required_environment(name: str, *, maximum_bytes: int) -> str:
    value = os.environ.get(name)
    if value is None or not value or len(value.encode("utf-8")) > maximum_bytes:
        raise BootstrapError(f"{name} is missing or invalid")
    return value


def initialize(origin: str, username: str, password: str) -> None:
    encoded = parse.urlencode(
        {"username": username, "password": password},
    ).encode("utf-8")
    login = request.Request(
        f"{origin}/api/v1/auth/login",
        data=encoded,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    opener = request.build_opener(NoRedirectHandler())
    try:
        with opener.open(login, timeout=10) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
    except error.HTTPError as exc:
        raise BootstrapError(
            "Agent Platform login was rejected; set the bootstrap credential environment variables"
        ) from exc
    except error.URLError as exc:
        raise BootstrapError("Agent Platform login is unreachable") from exc
    if status != 200 or len(body) > MAX_RESPONSE_BYTES:
        raise BootstrapError("Agent Platform login response is invalid")
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BootstrapError("Agent Platform login response is invalid") from exc
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or len(token) < 16:
        raise BootstrapError("Agent Platform login response is invalid")


def main(argv: list[str] | None = None) -> int:
    arguments = parse_args(argv or sys.argv[1:])
    try:
        initialize(
            local_origin(arguments.origin),
            required_environment(USERNAME_ENV, maximum_bytes=256),
            required_environment(PASSWORD_ENV, maximum_bytes=4_096),
        )
    except BootstrapError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print("Local Agent Platform identity context is ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
