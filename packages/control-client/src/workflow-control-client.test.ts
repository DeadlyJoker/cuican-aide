import assert from "node:assert/strict";
import test from "node:test";
import {
  workflowRunReadFixture,
  workflowGateReadFixture,
  workflowReadLocator,
  workflowReadDigest,
} from "../../contracts/src/workflow-run-read.test-support.ts";
import { MAX_WORKFLOW_RUN_SNAPSHOT_BYTES } from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

test("Workflow capability uses authenticated bounded reads and rejects corrupt or canceled responses without starting work", async () => {
  let calls = 0;
  const controller = new AbortController();
  let body: unknown = {
    version: "v1",
    admission: false,
    snapshots: true,
    humanGates: false,
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    fetch: async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        "https://control.example/api/v1/capabilities/workflow-execution-v1",
      );
      assert.equal(init!.method, "GET");
      assert.equal(
        new Headers(init!.headers).get("authorization"),
        "Bearer token",
      );
      return Response.json(body);
    },
  });
  assert.deepEqual(await client.getWorkflowExecutionCapability(), body);
  body = {
    version: "v2",
    admission: true,
    snapshots: false,
    humanGates: false,
  };
  await assert.rejects(
    client.getWorkflowExecutionCapability(),
    ControlApiProtocolError,
  );
  body = { padding: "x".repeat(2048) };
  await assert.rejects(client.getWorkflowExecutionCapability());
  controller.abort();
  await assert.rejects(
    client.getWorkflowExecutionCapability({ signal: controller.signal }),
  );
  assert.equal(calls, 3);
});

test("Workflow client binds snapshot and gate requests, credentials, CSRF and cancellation without an invented retry key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const controller = new AbortController();
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    csrfToken: "csrf",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      if (String(url).endsWith("decisions")) {
        const gate = workflowGateReadFixture();
        return Response.json({
          disposition: "committed",
          decision: {
            authority: gate.authority,
            actor: {
              tenantId: "tenant-1",
              spaceId: "space-1",
              actorId: "reviewer",
              principalId: "principal",
            },
            outcome: "approved",
            decidedAt: "2026-10-16T00:00:00Z",
          },
        });
      }
      return Response.json(
        String(url).includes("/gates/")
          ? workflowGateReadFixture()
          : workflowRunReadFixture(),
      );
    },
  });
  await client.getWorkflowRunSnapshot("run-1", { signal: controller.signal });
  await client.getWorkflowHumanGate(workflowReadLocator);
  await client.decideWorkflowHumanGate(workflowReadLocator, {
    inputDigest: workflowReadDigest,
    decision: "approved",
  });
  assert.equal(
    calls[0]!.url,
    "https://control.example/api/v1/workflow-runs/run-1",
  );
  assert.equal(calls[0]!.init.signal, controller.signal);
  assert.equal(
    calls[1]!.url,
    "https://control.example/api/v1/workflow-runs/run-1/nodes/gate/gates/request-1",
  );
  assert.equal(new Headers(calls[2]!.init.headers).get("x-csrf-token"), "csrf");
  assert.equal(
    new Headers(calls[2]!.init.headers).get("idempotency-key"),
    null,
  );
  for (const { init } of calls) {
    assert.equal(init.credentials, "include");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer token",
    );
  }
});

test("Workflow client rejects stale identities and decisions for another command", async () => {
  const gate = workflowGateReadFixture();
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    csrfToken: "csrf",
    fetch: async (url) =>
      Response.json(
        String(url).includes("/gates/") ? gate : workflowRunReadFixture(),
      ),
  });
  await assert.rejects(
    client.getWorkflowRunSnapshot("other"),
    ControlApiProtocolError,
  );
  await assert.rejects(
    client.getWorkflowHumanGate({
      ...workflowReadLocator,
      gateRequestId: "stale",
    }),
    ControlApiProtocolError,
  );
  await assert.rejects(
    client.decideWorkflowHumanGate(workflowReadLocator, {
      inputDigest: workflowReadDigest,
      decision: "rejected",
    }),
    ControlApiProtocolError,
  );
});

test("Workflow client validates mutation authority before sending and requires CSRF", async () => {
  let calls = 0;
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(
    client.decideWorkflowHumanGate(workflowReadLocator, {
      inputDigest: workflowReadDigest,
      decision: "approved",
    }),
    ControlApiProtocolError,
  );
  await assert.rejects(
    client.decideWorkflowHumanGate(workflowReadLocator, {
      inputDigest: workflowReadDigest,
      decision: "approved",
      actor: {},
    } as never),
  );
  assert.equal(calls, 0);
});

test("Workflow client cancels oversized response streams at the declared snapshot boundary", async () => {
  let canceled = false,
    reads = 0;
  const chunk = new Uint8Array(256 * 1024).fill(32);
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            reads++;
            controller.enqueue(chunk);
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(
    client.getWorkflowRunSnapshot("run-1"),
    ControlApiProtocolError,
  );
  assert.equal(canceled, true);
  assert.ok(reads <= MAX_WORKFLOW_RUN_SNAPSHOT_BYTES / chunk.byteLength + 2);
});

test("Workflow clients discard late transport replies after caller cancellation without replaying a command", async () => {
  for (const kind of ["snapshot", "gate", "decision"] as const) {
    const controller = new AbortController(),
      reason = new Error("owner_disposed");
    let calls = 0;
    const client = new ControlApiClient({
      baseUrl: "https://control.example",
      csrfToken: "csrf",
      fetch: async () => {
        calls++;
        controller.abort(reason);
        return Response.json(
          kind === "snapshot"
            ? workflowRunReadFixture()
            : workflowGateReadFixture(),
        );
      },
    });
    const options = { signal: controller.signal };
    const request = () =>
      kind === "snapshot"
        ? client.getWorkflowRunSnapshot("run-1", options)
        : kind === "gate"
          ? client.getWorkflowHumanGate(workflowReadLocator, options)
          : client.decideWorkflowHumanGate(
              workflowReadLocator,
              { inputDigest: workflowReadDigest, decision: "approved" },
              options,
            );
    await assert.rejects(request(), (error) => error === reason);
    await assert.rejects(request(), (error) => error === reason);
    assert.equal(calls, 1);
  }
});
