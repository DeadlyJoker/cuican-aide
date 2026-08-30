import assert from "node:assert/strict";

import { EventEmitter } from "node:events";

import { readFileSync } from "node:fs";

import type { RequestOptions } from "node:https";

import test from "node:test";

import type {
  DeviceWorkspaceListCommand,
  DeviceWorkspaceListDispatchReference,
  DeviceWorkspaceListDispatchResolution,
} from "@crewon/contracts";

import {
  DeviceWorkspaceListDispatchClientError,
  DeviceWorkspaceListDispatchProtocolClient,
  NodeHttpsDeviceWorkspaceListDispatchTransport,
  createDeviceWorkspaceListPeerDispatchRequest,
  createDeviceWorkspaceListDispatchRequest,
  type DeviceWorkspaceListDispatchHttpResponse,
  type DeviceWorkspaceListDispatchHttpTransportPort,
  type DeviceWorkspaceListDispatchDeadlineSchedulerPort,
  type DeviceWorkspaceListHttpsRequestFactory,
  type DeviceWorkspaceListHttpsRequestPort,
  type DeviceWorkspaceListHttpsResponsePort,
} from "./workspace-list-dispatch-client.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  valid: Readonly<{
    workspaceCommand: DeviceWorkspaceListCommand;
    workspaceEvents: readonly unknown[];
  }>;
}>;

for (const terminalEvent of ["error", "aborted"] as const) {
  test(`cleans deadline and abort listener after response ${terminalEvent}`, async () => {
    const deadline = new ManualDeadlineScheduler();
    const response = manualResponse();
    const controller = new AbortController();
    let requestDestroyCount = 0;
    const transport = new NodeHttpsDeviceWorkspaceListDispatchTransport({
      endpoint: "https://gateway.internal",
      tls: { key: "key", cert: "cert", ca: "ca" },
      deadlineScheduler: deadline,
      requestFactory: (_endpoint, _options, onResponse) => {
        const events = new EventEmitter();
        return {
          once(event, listener) {
            events.once(event, listener);
            return this;
          },
          setTimeout() {
            return this;
          },
          end() {
            onResponse(response.port);
          },
          destroy(error) {
            requestDestroyCount += 1;
            if (error !== undefined) events.emit("error", error);
          },
        };
      },
    });
    const pending = transport.post(Buffer.from("{}"), controller.signal, 1_000);
    if (terminalEvent === "error") {
      response.events.emit("error", new Error("response failed"));
    } else {
      response.events.emit("aborted");
    }

    await assert.rejects(
      pending,
      hasError("device_workspace_dispatch_transport_failed", "possiblySent"),
    );
    assert.equal(deadline.cancelCount, 1);
    controller.abort();
    deadline.expire();
    assert.equal(requestDestroyCount, 0);
    transport.close();
  });
}

class ScriptedTransport
  implements DeviceWorkspaceListDispatchHttpTransportPort
{
  response: DeviceWorkspaceListDispatchHttpResponse = jsonResponse(
    success("execute"),
  );
  readonly requests: Array<Readonly<{ body: Uint8Array; timeoutMs: number }>> =
    [];

  async post(
    body: Uint8Array,
    _signal: AbortSignal,
    timeoutMs: number,
  ): Promise<DeviceWorkspaceListDispatchHttpResponse> {
    this.requests.push({ body: structuredClone(body), timeoutMs });
    return this.response;
  }

  close(): void {}
}

function fakeRequest(
  onEnd: (body: Uint8Array) => void,
): DeviceWorkspaceListHttpsRequestPort {
  const events = new EventEmitter();
  return {
    once(event, listener) {
      events.once(event, listener);
      return this;
    },
    setTimeout() {
      return this;
    },
    end(body) {
      onEnd(body);
    },
    destroy(error) {
      if (error !== undefined) events.emit("error", error);
    },
  };
}

function fakeResponse(
  body: Buffer,
  extraHeaders: Readonly<Record<string, string>> = {},
): DeviceWorkspaceListHttpsResponsePort {
  const events = new EventEmitter();
  const response: DeviceWorkspaceListHttpsResponsePort = {
    statusCode: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    once(event, listener) {
      events.once(event, listener);
      return this;
    },
    destroy(error) {
      if (error !== undefined) events.emit("error", error);
    },
  };
  queueMicrotask(() => {
    if (body.byteLength > 0) events.emit("data", body);
    events.emit("end");
  });
  return response;
}

function manualResponse(): Readonly<{
  events: EventEmitter;
  port: DeviceWorkspaceListHttpsResponsePort;
}> {
  const events = new EventEmitter();
  return {
    events,
    port: {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      on(event, listener) {
        events.on(event, listener);
        return this;
      },
      once(event, listener) {
        events.once(event, listener);
        return this;
      },
      destroy(error) {
        if (error !== undefined) events.emit("error", error);
      },
    },
  };
}

class ManualDeadlineScheduler
  implements DeviceWorkspaceListDispatchDeadlineSchedulerPort
{
  cancelCount = 0;
  #callback: (() => void) | null = null;
  #active = false;

  schedule(_delayMs: number, callback: () => void): () => void {
    assert.equal(this.#callback, null);
    this.#callback = callback;
    this.#active = true;
    return () => {
      if (!this.#active) return;
      this.#active = false;
      this.cancelCount += 1;
    };
  }

  expire(): void {
    if (!this.#active) return;
    this.#callback?.();
  }
}

function command(): DeviceWorkspaceListCommand {
  return structuredClone(fixture.valid.workspaceCommand);
}

function reference(): DeviceWorkspaceListDispatchReference {
  return {
    deviceId: "device-1",
    executionId: "workspace-execution-1",
    workspaceBindingId: "workspace-binding-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    runtimeBindingId: "runtime-binding-1",
    actionDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    commandDigest:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    receiptId: "workspace-receipt-1",
  };
}

function peerRoute() {
  return {
    deviceId: "device-1",
    gatewayId: "gateway-target-1",
    connectionId: "connection-1",
    connectionEpoch: 3,
    leaseExpiresAt: "2026-08-08T00:30:00Z",
  } as const;
}

function completedResolution(): DeviceWorkspaceListDispatchResolution {
  return {
    status: "completed",
    executionId: "workspace-execution-1",
    receiptId: "workspace-receipt-1",
    terminal: structuredClone(fixture.valid.workspaceEvents[1]) as Extract<
      DeviceWorkspaceListDispatchResolution,
      { status: "completed" }
    >["terminal"],
  };
}

function success(operation: "execute" | "reconcile" | "cancel") {
  return {
    schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
    apiVersion: 1,
    operation,
    resolution: completedResolution(),
  };
}

function jsonResponse(
  value: unknown,
  statusCode = 200,
): DeviceWorkspaceListDispatchHttpResponse {
  return {
    statusCode,
    contentType: "application/json; charset=utf-8",
    body: Buffer.from(JSON.stringify(value), "utf8"),
  };
}

function hasError(
  code: string,
  certainty: "notSent" | "possiblySent",
): (error: unknown) => boolean {
  return (error) =>
    error instanceof DeviceWorkspaceListDispatchClientError &&
    error.code === code &&
    error.certainty === certainty;
}

test("builds and sends every provider-neutral request branch", async () => {
  const transport = new ScriptedTransport();
  const client = new DeviceWorkspaceListDispatchProtocolClient(transport, {
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  for (const operation of ["execute", "reconcile", "cancel"] as const) {
    transport.response = jsonResponse(success(operation));
    const resolution =
      operation === "execute"
        ? await client.execute(command(), new AbortController().signal)
        : await client[operation](reference(), new AbortController().signal);
    assert.deepEqual(resolution, completedResolution());
  }
  assert.deepEqual(
    transport.requests.map(({ body, timeoutMs }) => ({
      body: JSON.parse(Buffer.from(body).toString("utf8")),
      timeoutMs,
    })),
    [
      {
        body: createDeviceWorkspaceListDispatchRequest({
          operation: "execute",
          command: command(),
        }),
        timeoutMs: 35_000,
      },
      {
        body: createDeviceWorkspaceListDispatchRequest({
          operation: "reconcile",
          reference: reference(),
        }),
        timeoutMs: 35_000,
      },
      {
        body: createDeviceWorkspaceListDispatchRequest({
          operation: "cancel",
          reference: reference(),
        }),
        timeoutMs: 35_000,
      },
    ],
  );
});

test("builds every peer branch with authenticated source Worker authority", () => {
  for (const operation of ["execute", "reconcile", "cancel"] as const) {
    const request = createDeviceWorkspaceListPeerDispatchRequest({
      sourceGatewayId: "gateway-source-1",
      sourceWorker: {
        workerId: "worker-1",
        credentialId: "worker-credential-1",
      },
      route: peerRoute(),
      intent:
        operation === "execute"
          ? { operation, command: command() }
          : { operation, reference: reference() },
    });
    assert.deepEqual(request, {
      schemaVersion: "crewon.device-workspace-list-peer-dispatch-request.v0",
      apiVersion: 1,
      sourceGatewayId: "gateway-source-1",
      sourceWorker: {
        workerId: "worker-1",
        credentialId: "worker-credential-1",
      },
      route: peerRoute(),
      operation,
      ...(operation === "execute"
        ? { command: command() }
        : { reference: reference() }),
    });
  }

  assert.throws(() =>
    createDeviceWorkspaceListPeerDispatchRequest({
      sourceGatewayId: "gateway-source-1",
      sourceWorker: {
        workerId: "worker-1",
        credentialId: "caller supplied credential",
      },
      route: peerRoute(),
      intent: { operation: "reconcile", reference: reference() },
    }),
  );
});

test("bounds execute by the signed command deadline", async () => {
  const transport = new ScriptedTransport();
  transport.response = jsonResponse(success("execute"));
  const client = new DeviceWorkspaceListDispatchProtocolClient(transport, {
    requestTimeoutMs: 35_000,
    now: () => new Date("2026-08-08T00:59:50.000Z"),
  });
  await client.execute(command(), new AbortController().signal);
  assert.equal(transport.requests[0]?.timeoutMs, 10_000);

  const expired = new DeviceWorkspaceListDispatchProtocolClient(transport, {
    now: () => new Date("2026-08-08T01:00:00.000Z"),
  });
  await assert.rejects(
    expired.execute(command(), new AbortController().signal),
    hasError("device_workspace_dispatch_deadline_exceeded", "notSent"),
  );
});

test("preserves remote certainty and rejects malformed success after send", async () => {
  const transport = new ScriptedTransport();
  const client = new DeviceWorkspaceListDispatchProtocolClient(transport, {
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  transport.response = jsonResponse(
    {
      schemaVersion: "crewon.device-workspace-list-dispatch-error.v0",
      apiVersion: 1,
      code: "device_unavailable",
      retryable: true,
      certainty: "notSent",
    },
    503,
  );
  await assert.rejects(
    client.execute(command(), new AbortController().signal),
    hasError("device_unavailable", "notSent"),
  );

  transport.response = jsonResponse({ ...success("reconcile"), extra: true });
  await assert.rejects(
    client.reconcile(reference(), new AbortController().signal),
    hasError(
      "device_workspace_dispatch_remote_response_invalid",
      "possiblySent",
    ),
  );
});

test("aborts before transport with notSent certainty", async () => {
  const transport = new ScriptedTransport();
  const client = new DeviceWorkspaceListDispatchProtocolClient(transport);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.reconcile(reference(), controller.signal),
    hasError("device_workspace_dispatch_aborted", "notSent"),
  );
  assert.equal(transport.requests.length, 0);
});

test("uses the fixed Workspace path and strict TLS 1.3 mTLS options", async () => {
  const deadline = new ManualDeadlineScheduler();
  let captured:
    | Readonly<{ endpoint: URL; options: RequestOptions; body: Uint8Array }>
    | undefined;
  const responseBody = Buffer.from(
    JSON.stringify(success("reconcile")),
    "utf8",
  );
  const requestFactory: DeviceWorkspaceListHttpsRequestFactory = (
    endpoint,
    options,
    onResponse,
  ) =>
    fakeRequest((body) => {
      captured = { endpoint, options, body };
      onResponse(fakeResponse(responseBody));
    });
  const transport = new NodeHttpsDeviceWorkspaceListDispatchTransport({
    endpoint: "https://gateway.internal",
    tls: { key: "key", cert: "cert", ca: "ca", servername: "gateway.internal" },
    requestFactory,
    deadlineScheduler: deadline,
  });
  const body = Buffer.from(
    JSON.stringify(
      createDeviceWorkspaceListDispatchRequest({
        operation: "reconcile",
        reference: reference(),
      }),
    ),
    "utf8",
  );
  const response = await transport.post(
    body,
    new AbortController().signal,
    10_000,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(captured?.endpoint.href, "https://gateway.internal/");
  assert.equal(
    captured?.options.path,
    "/worker/v1/device-workspace-list-dispatch",
  );
  const agentOptions = (
    captured?.options.agent as { options?: Record<string, unknown> } | undefined
  )?.options;
  assert.equal(agentOptions?.minVersion, "TLSv1.3");
  assert.equal(agentOptions?.rejectUnauthorized, true);
  assert.equal(agentOptions?.servername, "gateway.internal");
  assert.deepEqual(captured?.body, body);
  assert.equal(deadline.cancelCount, 1);
  deadline.expire();
  transport.close();
});
