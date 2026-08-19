import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveRuntimeOperationalPort,
  RuntimeOperationalMetrics,
  startRuntimeOperationalServer,
} from "./runtime-operational-server.ts";

test("serves bounded worker health and Prometheus outcomes on loopback", async () => {
  let now = 1_000;
  const metrics = new RuntimeOperationalMetrics({ now: () => now });
  metrics.recordOutcome({ kind: "idle" });
  metrics.recordOutcome({ kind: "retried", runId: "run-secret", code: "busy" });
  metrics.recordOutcome({
    kind: "retried",
    runId: "other-secret",
    code: "busy",
  });
  const server = await startRuntimeOperationalServer({ port: 0, metrics });
  try {
    assert.match(server.origin, /^http:\/\/127[.]0[.]0[.]1:\d+$/u);
    assert.deepEqual(await response(server.origin, "/health/live"), {
      status: 200,
      type: "application/json; charset=utf-8",
      body: '{"status":"ok"}\n',
    });
    assert.equal((await response(server.origin, "/health/ready")).status, 503);
    metrics.setReady(true);
    assert.equal((await response(server.origin, "/health/ready")).status, 200);
    now = 3_500;
    const rendered = await response(server.origin, "/metrics");
    assert.equal(rendered.status, 200);
    assert.ok(rendered.type);
    assert.match(rendered.type, /^text\/plain; version=0[.]0[.]4/u);
    assert.match(rendered.body, /crewon_runtime_worker_ready 1/u);
    assert.match(rendered.body, /crewon_runtime_worker_uptime_seconds 2[.]5/u);
    assert.match(
      rendered.body,
      /crewon_runtime_worker_outcomes_total\{kind="idle",code=""\} 1/u,
    );
    assert.match(
      rendered.body,
      /crewon_runtime_worker_outcomes_total\{kind="retried",code="busy"\} 2/u,
    );
    assert.equal(rendered.body.includes("run-secret"), false);
    assert.equal(
      (await response(server.origin, "/metrics?tenant=secret")).status,
      404,
    );
    assert.equal(
      (
        await response(server.origin, "/metrics", {
          method: "POST",
        })
      ).status,
      405,
    );
  } finally {
    await server.close();
  }
});

test("requires one explicit production operational port", () => {
  assert.equal(resolveRuntimeOperationalPort({}, false), null);
  assert.equal(
    resolveRuntimeOperationalPort(
      { CREWON_RUNTIME_OPERATIONAL_PORT: "3223" },
      true,
    ),
    3223,
  );
  assert.throws(
    () => resolveRuntimeOperationalPort({}, true),
    /CREWON_RUNTIME_OPERATIONAL_PORT_required/u,
  );
  for (const value of ["0", "65536", "3.2", "invalid"]) {
    assert.throws(
      () =>
        resolveRuntimeOperationalPort(
          { CREWON_RUNTIME_OPERATIONAL_PORT: value },
          false,
        ),
      /CREWON_RUNTIME_OPERATIONAL_PORT_invalid/u,
    );
  }
});

async function response(origin: string, path: string, init: RequestInit = {}) {
  const result = await fetch(`${origin}${path}`, init);
  return {
    status: result.status,
    type: result.headers.get("content-type"),
    body: await result.text(),
  };
}
