import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { ControlOperationalMetrics } from "./control-operational-metrics.ts";

test("exports bounded Control latency, readiness, and loop failures", async () => {
  let now = 1_000;
  let ready = true;
  let outboxFailure: string | null = null;
  const app = Fastify({ logger: false });
  const metrics = new ControlOperationalMetrics({
    readiness: {
      async checkReady() {
        if (!ready) throw new Error("store_unavailable");
      },
    },
    outboxFailure: () => outboxFailure,
    automationFailure: () => "scheduler_failed",
    now: () => now,
  });
  metrics.install(app);
  app.get<{ Params: { runId: string } }>(
    "/api/v1/runs/:runId",
    async (_request, reply) => {
      now += 25;
      return reply.code(503).send({ code: "unavailable" });
    },
  );
  try {
    await app.inject({ method: "GET", url: "/api/v1/runs/secret-run-id" });
    outboxFailure = "outbox_failed";
    ready = false;
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/metrics",
    });
    assert.equal(response.statusCode, 200);
    assert.match(
      response.headers["content-type"] ?? "",
      /^text\/plain; version=0[.]0[.]4/u,
    );
    assert.match(response.body, /crewon_control_ready 0/u);
    assert.match(
      response.body,
      /crewon_control_background_failure\{component="outbox",code="outbox_failed"\} 1/u,
    );
    assert.match(
      response.body,
      /crewon_control_background_failure\{component="automation_scheduler",code="scheduler_failed"\} 1/u,
    );
    assert.match(
      response.body,
      /crewon_control_http_requests_total\{method="GET",route="\/api\/v1\/runs\/:runId",status="5xx"\} 1/u,
    );
    assert.match(
      response.body,
      /crewon_control_http_request_duration_seconds_bucket\{method="GET",route="\/api\/v1\/runs\/:runId",status="5xx",le="0[.]025"\} 1/u,
    );
    assert.equal(response.body.includes("secret-run-id"), false);
  } finally {
    await app.close();
  }
});
