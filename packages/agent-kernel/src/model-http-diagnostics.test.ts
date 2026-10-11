import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedNetworkCauseCode,
  modelHttpResponseDiagnostics,
  modelHttpTerminationDiagnostics,
} from "./model-http-diagnostics.ts";

test("HTTP response diagnostics select five bounded fields without enumerating headers", () => {
  const calls: string[] = [];
  const values: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "server": "cloudflare",
    "cf-ray": "ray-abc-SJC",
    "x-oneapi-request-id": "request-123",
    "authorization": "Bearer secret",
    "set-cookie": "session=secret",
    "cookie": "session=secret",
    "x-debug-body": "secret body",
  };
  assert.deepEqual(
    modelHttpResponseDiagnostics(524, {
      get: (name) => {
        calls.push(name);
        return values[name] ?? null;
      },
    }),
    {
      status: 524,
      contentType: values["content-type"],
      server: "cloudflare",
      cfRay: "ray-abc-SJC",
      oneApiRequestId: "request-123",
    },
  );
  assert.deepEqual(calls, [
    "content-type",
    "server",
    "cf-ray",
    "x-oneapi-request-id",
  ]);
});

test("malformed or oversized header values are omitted without failing the request", () => {
  assert.deepEqual(
    modelHttpResponseDiagnostics(200, {
      get: (name) =>
        name === "server"
          ? "a".repeat(129)
          : name === "cf-ray"
            ? "ray\nsecret"
            : name === "x-oneapi-request-id"
              ? "非ASCII"
              : " text/event-stream ",
    }),
    { status: 200, contentType: "text/event-stream" },
  );
  assert.deepEqual(
    modelHttpResponseDiagnostics(502, {
      get: () => {
        throw new Error("secret");
      },
    }),
    { status: 502 },
  );
  for (const status of [0, 99, 600, NaN, Infinity, 200.5])
    assert.equal(
      modelHttpResponseDiagnostics(status, {
        get: () => assert.fail("invalid status"),
      }),
      null,
    );
});

test("network diagnostics inspect only a finite allowlist through bounded nested causes and aggregates", () => {
  const reset = Object.assign(new Error("secret URL and API key"), {
    code: "ECONNRESET",
  });
  assert.equal(
    boundedNetworkCauseCode(new Error("secret", { cause: reset })),
    "ECONNRESET",
  );
  assert.equal(
    boundedNetworkCauseCode(
      new AggregateError(
        [new Error("secret"), { code: "UND_ERR_SOCKET" }],
        "secret",
      ),
    ),
    "UND_ERR_SOCKET",
  );
  assert.equal(
    boundedNetworkCauseCode({
      code: "secret_arbitrary_code",
      message: "secret",
      cause: "secret",
    }),
    null,
  );
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(boundedNetworkCauseCode(cycle), null);
  let deep: unknown = { code: "ECONNRESET" };
  for (let depth = 0; depth < 5; depth += 1) deep = { cause: deep };
  assert.equal(boundedNetworkCauseCode(deep), null);
  assert.equal(
    boundedNetworkCauseCode({
      errors: Array.from({ length: 1000 }, (_, i) => (i === 4 ? reset : {})),
    }),
    null,
  );
});

test("network diagnostics never invoke error or aggregate getters and tolerate proxies", () => {
  let accessed = 0;
  const value = Object.defineProperties(
    {},
    Object.fromEntries(
      ["message", "stack", "code", "cause", "errors"].map((key) => [
        key,
        {
          get: () => {
            accessed += 1;
            throw new Error("secret");
          },
        },
      ]),
    ),
  );
  assert.equal(boundedNetworkCauseCode(value), null);
  assert.equal(accessed, 0);
  assert.equal(
    boundedNetworkCauseCode(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error("secret");
          },
        },
      ),
    ),
    null,
  );
  assert.deepEqual(
    modelHttpTerminationDiagnostics({
      reason: "transportError",
      code: "Secret: bearer key",
      cause: value,
    }),
    { reason: "transportError" },
  );
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  assert.equal(boundedNetworkCauseCode({ errors: revoked.proxy }), null);
  assert.deepEqual(
    modelHttpTerminationDiagnostics({
      reason: "transportError",
      code: "responses_transport_unavailable",
      cause: { errors: revoked.proxy },
    }),
    { reason: "transportError", code: "responses_transport_unavailable" },
  );
});
