import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
  ControlApiTransportError,
} from "./control-api-client.ts";
import { WORKFLOW_RECOVERY_CONTEXT_HEADER } from "@crewon/contracts";
const contextId = `sha256:${"a".repeat(64)}`;
const locator = { runId: "run-1", nodeId: "node-1", gateRequestId: "gate-1" };
const gate = {
  inputDigest: `sha256:${"b".repeat(64)}`,
  decision: "approved" as const,
};
test("recovery context discovery is authenticated, bounded, strict and cancellation-aware", async () => {
  let calls = 0,
    body: unknown = { version: "v1", contextId };
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    fetch: async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        "https://control.example/api/v1/capabilities/workflow-recovery-context-v1",
      );
      assert.equal(init!.method, "GET");
      assert.equal(
        new Headers(init!.headers).get("authorization"),
        "Bearer token",
      );
      return Response.json(body);
    },
  });
  assert.deepEqual(await client.getWorkflowRecoveryContext(), body);
  body = { version: "v1", contextId: null };
  assert.deepEqual(await client.getWorkflowRecoveryContext(), body);
  body = { version: "v2", contextId };
  await assert.rejects(
    client.getWorkflowRecoveryContext(),
    ControlApiProtocolError,
  );
  body = { version: "v1", contextId, extra: true };
  await assert.rejects(
    client.getWorkflowRecoveryContext(),
    ControlApiProtocolError,
  );
  body = { padding: "x".repeat(2048) };
  await assert.rejects(client.getWorkflowRecoveryContext());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.getWorkflowRecoveryContext({ signal: controller.signal }),
  );
  assert.equal(calls, 5);
});
test("Workflow context pins start, gate decision/review and Run cancellation without changing command bodies or receipt keys", async () => {
  const calls: { url: string; headers: Headers; body: unknown }[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    csrfToken: "csrf",
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        headers: new Headers(init!.headers),
        body: JSON.parse(String(init!.body)),
      });
      throw new Error("fixture disconnected");
    },
  });
  const options = { workflowRecoveryContext: contextId };
  await assert.rejects(
    client.startWorkflowRun(
      {
        threadId: "thread-1",
        workflowVersionId: "version-1",
        input: { prompt: "safe" },
      },
      "original-start-key",
      options,
    ),
    ControlApiTransportError,
  );
  await assert.rejects(
    client.decideWorkflowHumanGate(locator, gate, options),
    ControlApiTransportError,
  );
  await assert.rejects(
    client.reviewWorkflowHumanGate(
      locator,
      { ...gate, comment: "exact\ncomment", commentContext: "descendants-v1" },
      options,
    ),
    ControlApiTransportError,
  );
  await assert.rejects(
    client.cancelRun(
      "run-1",
      { expectedRevision: 7 },
      "original-cancel-key",
      options,
    ),
    ControlApiTransportError,
  );
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.headers.get(WORKFLOW_RECOVERY_CONTEXT_HEADER), contextId);
    assert.equal(call.headers.get("authorization"), "Bearer token");
    assert.equal(call.headers.get("x-csrf-token"), "csrf");
  }
  assert.equal(calls[0]!.headers.get("idempotency-key"), "original-start-key");
  assert.equal(calls[3]!.headers.get("idempotency-key"), "original-cancel-key");
  assert.equal(calls[1]!.headers.has("idempotency-key"), false);
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      {
        threadId: "thread-1",
        workflowVersionId: "version-1",
        input: { prompt: "safe" },
      },
      gate,
      { ...gate, comment: "exact\ncomment", commentContext: "descendants-v1" },
      { expectedRevision: 7 },
    ],
  );
  const count = calls.length;
  await assert.rejects(
    client.cancelRun("run-1", { expectedRevision: 7 }, "original-cancel-key", {
      workflowRecoveryContext: contextId + "," + contextId,
    }),
  );
  assert.equal(calls.length, count);
});
test("legacy omission does not emit a recovery header and late cancellation rejects discovery", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    fetch: async (_url, init) => {
      calls++;
      assert.equal(
        new Headers(init!.headers).has(WORKFLOW_RECOVERY_CONTEXT_HEADER),
        false,
      );
      controller.abort();
      return Response.json({ version: "v1", contextId });
    },
  });
  await assert.rejects(
    client.getWorkflowRecoveryContext({ signal: controller.signal }),
  );
  assert.equal(calls, 1);
  const old = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    fetch: async (_url, init) => {
      assert.equal(
        new Headers(init!.headers).has(WORKFLOW_RECOVERY_CONTEXT_HEADER),
        false,
      );
      throw Error("fixture no response");
    },
  });
  await assert.rejects(
    old.startWorkflowRun(
      { threadId: "thread-1", workflowVersionId: "version-1", input: {} },
      "old-key",
    ),
    ControlApiTransportError,
  );
});

test("mixed-version discovery cannot make guarded writes execute on legacy routes", async (t) => {
  const { createServer } = await import("node:http");
  let writes = 0;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url!;
    paths.push(path);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ version: "v1", contextId }));
      return;
    }
    if (
      [
        "/api/v1/workflow-runs",
        "/api/v1/runs/run-1:cancel",
        "/api/v1/workflow-runs/run-1/nodes/node-1/gates/gate-1/decisions",
        "/api/v1/workflow-runs/run-1/nodes/node-1/gates/gate-1/review-v1",
      ].includes(path)
    )
      writes++;
    response.statusCode = 404;
    response.end(
      JSON.stringify({
        error: {
          category: "notFound",
          code: "route_not_found",
          requestId: "fixture-old-node",
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new ControlApiClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accessToken: "fixture",
    csrfToken: "fixture",
  });
  const discovery = await client.getWorkflowRecoveryContext();
  assert.equal(discovery.contextId, contextId);
  const options = { workflowRecoveryContext: discovery.contextId! };
  await assert.rejects(
    client.startWorkflowRun(
      { threadId: "thread-1", workflowVersionId: "version-1", input: {} },
      "same-key",
      options,
    ),
  );
  await assert.rejects(client.decideWorkflowHumanGate(locator, gate, options));
  await assert.rejects(
    client.reviewWorkflowHumanGate(
      locator,
      { ...gate, comment: null },
      options,
    ),
  );
  await assert.rejects(
    client.cancelRun(
      "run-1",
      { expectedRevision: 1 },
      "same-cancel-key",
      options,
    ),
  );
  assert.equal(writes, 0);
  assert.deepEqual(paths.slice(1), [
    "/api/v1/workflow-runs:admit-v1",
    "/api/v1/workflow-runs/run-1/nodes/node-1/gates/gate-1/decisions-guarded-v1",
    "/api/v1/workflow-runs/run-1/nodes/node-1/gates/gate-1/review-guarded-v1",
    "/api/v1/runs/run-1:cancel-guarded-v1",
  ]);
});
test("route and header use a single captured context even when the caller supplied a changing accessor", async () => {
  const observed: { path: string; context: string | null }[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "token",
    csrfToken: "csrf",
    fetch: async (url, init) => {
      observed.push({
        path: new URL(String(url)).pathname,
        context: new Headers(init!.headers).get(
          WORKFLOW_RECOVERY_CONTEXT_HEADER,
        ),
      });
      throw Error("fixture disconnect");
    },
  });
  const commands = [
    (options: Parameters<typeof client.startWorkflowRun>[2]) =>
      client.startWorkflowRun(
        { threadId: "thread-1", workflowVersionId: "version-1", input: {} },
        "key",
        options,
      ),
    (options: Parameters<typeof client.startWorkflowRun>[2]) =>
      client.cancelRun("run-1", { expectedRevision: 1 }, "cancel-key", options),
    (options: Parameters<typeof client.startWorkflowRun>[2]) =>
      client.reviewWorkflowHumanGate(
        locator,
        { ...gate, comment: null },
        options,
      ),
    (options: Parameters<typeof client.startWorkflowRun>[2]) =>
      client.decideWorkflowHumanGate(locator, gate, options),
  ];
  for (const command of commands) {
    let reads = 0;
    await assert.rejects(
      command({
        get workflowRecoveryContext() {
          reads++;
          return reads === 1 ? contextId : undefined;
        },
      }),
    );
    assert.equal(reads, 1);
  }
  assert.ok(
    observed.every(
      (row) =>
        row.context === contextId &&
        (row.path.endsWith("-v1") || row.path.endsWith("admit-v1")),
    ),
  );
});
