import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { inspect } from "node:util";
import test from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";
import type { ToolExecutionCommand } from "@crewon/tool-broker";

import {
  CrewonRemoteMcpMutationError,
  CrewonRemoteMcpMutationProvider,
  type CrewonRemoteMcpMutationHttpPort,
} from "./crewon-remote-mutation-provider.ts";

test("executes once and a fresh adapter reconciles the durable result", async (t) => {
  const harness = await durableHarness();
  t.after(harness.close);
  const execution = mutationExecution();
  const first = provider(harness.endpoint);

  assert.deepEqual(await first.execute(execution, signal()), {
    status: "completed",
    providerReceiptId: "receipt-execution-1",
    result: { structuredContent: { durable: true } },
  });
  const recovered = provider(harness.endpoint);
  assert.deepEqual(await recovered.reconcile(execution, signal()), {
    status: "completed",
    providerReceiptId: "receipt-execution-1",
    result: { structuredContent: { durable: true } },
  });
  assert.deepEqual(await recovered.cancel(execution, signal()), {
    status: "canceled",
    providerReceiptId: "receipt-execution-1",
  });
  assert.equal(harness.executeCount(), 1);
  assertExactWire(harness.requests, execution.command);
});
test("canonical idempotency keys survive nested key reordering", async () => {
  const keys: string[] = [];
  const post: CrewonRemoteMcpMutationHttpPort["post"] = async (request) => {
    keys.push(request.headers["idempotency-key"] ?? "");
    const wire = JSON.parse(new TextDecoder().decode(request.body));
    return jsonResponse(
      responseEnvelope(wire.phase, {
        status: "unknownOutcome",
        providerReceiptId: null,
      }),
    );
  };
  const execution = mutationExecution();
  const reordered = reverseKeyOrder(execution) as typeof execution;
  await productionProvider(post).execute(execution, signal());
  await productionProvider(post).execute(reordered, signal());
  await productionProvider(post).reconcile(reordered, signal());
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
});
test("rejects command authority extras and normalizes preflight failures", async () => {
  let calls = 0;
  const adapter = productionProvider(async () => {
    calls += 1;
    throw new Error("unexpected_send");
  });
  const execution = mutationExecution();
  const invalid = [
    { ...execution, command: { ...execution.command, authority: "forged" } },
    {
      ...execution,
      command: {
        ...execution.command,
        executionLease: {
          ...execution.command.executionLease,
          authority: "forged",
        },
      },
    },
    {
      ...execution,
      command: {
        ...execution.command,
        approvalProof: {
          schemaVersion: "crewon.tool-approval-proof.v0",
          authority: "forged",
        },
      },
    },
  ];
  for (const candidate of invalid) {
    await assert.rejects(
      adapter.execute(candidate as typeof execution, signal()),
      isNotSent("remote_mcp_mutation_command_shape_invalid"),
    );
  }
  const brokerInvalid = {
    ...execution,
    command: {
      ...execution.command,
      actionDigest: "not-a-digest",
    },
  };
  await assert.rejects(
    adapter.execute(brokerInvalid, signal()),
    isNotSent("remote_mcp_mutation_preflight_invalid"),
  );
  assert.equal(calls, 0);
});
test("possibly-sent timeout is recovered only through reconcile", async (t) => {
  const harness = await durableHarness({ hangExecuteResponse: true });
  t.after(harness.close);
  const execution = mutationExecution();
  await assert.rejects(
    provider(harness.endpoint, { deadlineMs: 30 }).execute(execution, signal()),
    (error) =>
      error instanceof CrewonRemoteMcpMutationError &&
      error.certainty === "possiblySent",
  );

  assert.deepEqual(
    await provider(harness.endpoint).reconcile(execution, signal()),
    {
      status: "completed",
      providerReceiptId: "receipt-execution-1",
      result: { structuredContent: { durable: true } },
    },
  );
  assert.equal(harness.executeCount(), 1);
  assert.deepEqual(
    harness.requests.map((request) => request.body.phase),
    ["execute", "reconcile"],
  );
});
test("rejects unsafe endpoints and never exposes bearer credentials", async () => {
  for (const endpoint of [
    "http://example.com/mutate",
    "http://localhost/mutate",
    "https://user@example.com/mutate",
    "https://example.com/mutate?authority=attacker",
    "https://example.com/mutate#fragment",
  ]) {
    assert.throws(
      () => provider(endpoint),
      hasCode("remote_mcp_mutation_endpoint_invalid"),
    );
  }
  const secret = "top-secret-bearer-value";
  let idempotencyKey = "";
  const adapter = productionProvider(async (request) => {
    idempotencyKey = request.headers["idempotency-key"] ?? "";
    throw new Error(`${request.headers.authorization} ${idempotencyKey}`);
  }, secret);
  let caught: unknown;
  try {
    await adapter.execute(mutationExecution(), signal());
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof CrewonRemoteMcpMutationError);
  assert.equal(inspect(caught).includes(secret), false);
  assert.equal(inspect(caught).includes(idempotencyKey), false);
  assert.equal(inspect(adapter).includes(secret), false);
});
test("distinguishes caller abort and deadline and cancels response readers", async () => {
  for (const cause of ["caller", "deadline"] as const) {
    let cancelCount = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise(() => undefined),
        cancel: () => {
          cancelCount += 1;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const controller = new AbortController();
    const adapter = productionProvider(
      async () => response,
      "fixture-secret",
      cause === "deadline" ? 20 : 1_000,
    );
    const pending = adapter.execute(mutationExecution(), controller.signal);
    if (cause === "caller") setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      pending,
      hasCode(
        cause === "caller"
          ? "remote_mcp_mutation_aborted"
          : "remote_mcp_mutation_deadline_exceeded",
      ),
    );
    assert.equal(cancelCount, 1);
  }
});
test("strictly rejects redirects, non-JSON, oversized and drifted responses", async () => {
  const execution = mutationExecution();
  const cases: readonly [Response, string][] = [
    [
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.invalid" },
      }),
      "remote_mcp_mutation_redirect_rejected",
    ],
    [
      new Response("no", { headers: { "content-type": "text/plain" } }),
      "remote_mcp_mutation_non_json_response",
    ],
    [
      new Response("x", {
        headers: {
          "content-type": "application/json",
          "content-length": "999999",
        },
      }),
      "remote_mcp_mutation_response_too_large",
    ],
    [
      jsonResponse(
        responseEnvelope(
          "execute",
          { status: "unknownOutcome", providerReceiptId: null },
          { authority: "attacker" },
        ),
      ),
      "remote_mcp_mutation_response_identity_invalid",
    ],
    [
      jsonResponse(
        responseEnvelope("cancel", {
          status: "unknownOutcome",
          providerReceiptId: null,
        }),
      ),
      "remote_mcp_mutation_response_identity_invalid",
    ],
    [
      jsonResponse(
        responseEnvelope("execute", {
          status: "completed",
          providerReceiptId: "receipt-1",
          result: { structuredContent: {}, authority: "attacker" },
        }),
      ),
      "remote_mcp_mutation_response_invalid",
    ],
  ];
  for (const [response, code] of cases) {
    const adapter = productionProvider(async (request) => {
      assert.equal(request.headers.authorization, "Bearer fixture-secret");
      return response;
    });
    await assert.rejects(adapter.execute(execution, signal()), hasCode(code));
  }
});
test("redacts secrets from response stream errors", async () => {
  const secret = "stream-secret";
  let idempotencyKey = "";
  const adapter = productionProvider(async (request) => {
    idempotencyKey = request.headers["idempotency-key"] ?? "";
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(`${secret} ${idempotencyKey}`));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }, secret);
  let caught: unknown;
  try {
    await adapter.execute(mutationExecution(), signal());
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof CrewonRemoteMcpMutationError);
  assert.equal(inspect(caught).includes(secret), false);
  assert.equal(inspect(caught).includes(idempotencyKey), false);
});

function productionProvider(
  post: CrewonRemoteMcpMutationHttpPort["post"],
  token = "fixture-secret",
  deadlineMs = 30_000,
): CrewonRemoteMcpMutationProvider {
  return new CrewonRemoteMcpMutationProvider({
    endpoint: "https://provider.example/mutate",
    auth: { kind: "bearer", token },
    deadlineMs,
    network: { mode: "production", http: { post } },
  });
}

function provider(
  endpoint: string,
  options: Readonly<{ deadlineMs?: number }> = {},
): CrewonRemoteMcpMutationProvider {
  return new CrewonRemoteMcpMutationProvider({
    endpoint,
    ...(options.deadlineMs === undefined
      ? {}
      : { deadlineMs: options.deadlineMs }),
    auth: { kind: "bearer", token: "fixture-secret" },
    network: { mode: "standaloneLoopback" },
  });
}

async function durableHarness(options: { hangExecuteResponse?: boolean } = {}) {
  const durable = new Map<string, unknown>();
  const requests: Array<{
    body: Record<string, any>;
    headers: IncomingMessage["headers"];
  }> = [];
  let executeCount = 0;
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readRequest(request));
    requests.push({ body, headers: request.headers });
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/mcp-mutations");
    assert.equal(request.headers.authorization, "Bearer fixture-secret");
    const idempotencyKey = request.headers["idempotency-key"];
    assert.ok(typeof idempotencyKey === "string");
    assert.match(idempotencyKey, /^crewon-mcp-v1-[a-f0-9]{64}$/u);
    const id = body.providerExecutionId;
    if (body.phase === "execute") {
      executeCount += 1;
      durable.set(id, { structuredContent: { durable: true } });
      if (options.hangExecuteResponse) return;
    }
    const resolution =
      body.phase === "cancel"
        ? { status: "canceled", providerReceiptId: `receipt-${id}` }
        : durable.has(id)
          ? {
              status: "completed",
              providerReceiptId: `receipt-${id}`,
              result: durable.get(id),
            }
          : { status: "unknownOutcome", providerReceiptId: null };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseEnvelope(body.phase, resolution)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp-mutations`,
    requests,
    executeCount: () => executeCount,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function assertExactWire(
  requests: Array<{
    body: Record<string, any>;
    headers: IncomingMessage["headers"];
  }>,
  command: ToolExecutionCommand,
): void {
  const expectedKeys = [
    "command",
    "phase",
    "providerExecutionId",
    "schemaVersion",
    "toolName",
  ];
  assert.deepEqual(
    requests.map(({ body }) => body.phase),
    ["execute", "reconcile", "cancel"],
  );
  for (const { body } of requests) {
    assert.deepEqual(Object.keys(body).sort(), expectedKeys);
    assert.equal(body.schemaVersion, "crewon.remote-mcp-mutation.v1");
    assert.equal(body.providerExecutionId, "execution-1");
    assert.equal(body.toolName, "provider.original-tool");
    assert.deepEqual(body.command, command);
  }
  assert.notEqual(
    requests[0]?.headers["idempotency-key"],
    requests[1]?.headers["idempotency-key"],
  );
}

function responseEnvelope(
  phase: string,
  resolution: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    schemaVersion: "crewon.remote-mcp-mutation.v1",
    phase,
    providerExecutionId: "execution-1",
    toolName: "provider.original-tool",
    resolution,
    ...extra,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
function signal(): AbortSignal {
  return new AbortController().signal;
}
function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof CrewonRemoteMcpMutationError && error.code === code;
}
function isNotSent(code: string) {
  return (error: unknown) =>
    error instanceof CrewonRemoteMcpMutationError &&
    error.code === code &&
    error.certainty === "notSent";
}
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, nested]) => [key, reverseKeyOrder(nested)]),
  );
}

function mutationExecution() {
  const input = '{"value":"hello"}';
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: {
      kind: "function" as const,
      name: "mcp__remote__original-tool",
      inputDigest: sha256(input),
    },
    effect: "mutation" as const,
    recovery: "reconcilable" as const,
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    resourceBindingId: null,
    credentialBindingId: "credential-1",
    executionTarget: { kind: "remote" as const, bindingId: "mcp-provider-1" },
    capability: "mcp.tool.mutate",
    approvalRequirement: "none" as const,
    limits: { timeoutMs: 30_000, maxOutputBytes: 4096, maxArtifactBytes: 8192 },
  };
  const command: ToolExecutionCommand = {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: "execution-1",
    executionLease: {
      workItemId: "work-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    actionIntent,
    approvalProof: null,
    idempotencyKey: "run-1/tool/call-1",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    kind: "function",
    name: "mcp__remote__original-tool",
    input,
  };
  return {
    providerExecutionId: command.executionId,
    toolName: "provider.original-tool",
    command,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
