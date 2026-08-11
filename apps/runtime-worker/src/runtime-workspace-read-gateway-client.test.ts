import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { RequestOptions } from "node:https";
import test from "node:test";

import type {
  DeviceFilesystemReadCommand,
  DeviceFilesystemReadDispatchReference,
  DeviceFilesystemReadDispatchResolution,
  DeviceFilesystemReadEvent,
} from "@crewon/contracts";

import {
  HttpsRuntimeWorkspaceReadGatewayClient,
  RuntimeWorkspaceReadGatewayClientError,
  RuntimeWorkspaceReadGatewayProtocolClient,
  type RuntimeWorkspaceReadDeadlineSchedulerPort,
  type RuntimeWorkspaceReadGatewayHttpResponse,
  type RuntimeWorkspaceReadGatewayTransportPort,
  type RuntimeWorkspaceReadHttpsRequestFactory,
  type RuntimeWorkspaceReadHttpsResponsePort,
} from "./runtime-workspace-read-gateway-client.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  valid: Readonly<{
    filesystemReadCommand: DeviceFilesystemReadCommand;
    filesystemReadEvents: readonly DeviceFilesystemReadEvent[];
  }>;
}>;

const routeIntent = {
  deviceBindingId: "device-binding-1",
  runtimeBindingId: "runtime-binding-1",
};

class ScriptedTransport implements RuntimeWorkspaceReadGatewayTransportPort {
  response = responseOf(success("execute"));
  requests: Array<
    Readonly<{ input: any; signal: AbortSignal; timeoutMs: number }>
  > = [];

  async post(body: Uint8Array, signal: AbortSignal, timeoutMs: number) {
    this.requests.push({
      input: JSON.parse(Buffer.from(body).toString("utf8")),
      signal,
      timeoutMs,
    });
    return this.response;
  }
  close() {}
}

test("executes and accepts an exactly correlated terminal replay", async () => {
  const transport = new ScriptedTransport();
  const client = protocol(transport);
  const first = await client.execute(
    routeIntent,
    command(),
    new AbortController().signal,
  );
  const replay = await client.execute(
    routeIntent,
    command(),
    new AbortController().signal,
  );

  assert.deepEqual(first, success("execute").resolution);
  assert.deepEqual(replay, first);
  assert.deepEqual(
    transport.requests.map(({ input }) => input),
    [
      workerRequest("execute", { command: command() }),
      workerRequest("execute", { command: command() }),
    ],
  );
  assert.deepEqual(
    transport.requests.map(({ timeoutMs }) => timeoutMs),
    [35_000, 35_000],
  );
});

test("reconciles the durable receipt and sends passive lease-exact cancel", async () => {
  const transport = new ScriptedTransport();
  const client = protocol(transport);
  transport.response = responseOf(success("reconcile"));
  const reconciled = await client.reconcile(
    routeIntent,
    reference(),
    new AbortController().signal,
  );
  transport.response = responseOf(success("cancel"));
  const canceled = await client.cancel(
    routeIntent,
    reference(),
    new AbortController().signal,
  );

  assert.deepEqual(reconciled, success("reconcile").resolution);
  assert.deepEqual(canceled, success("cancel").resolution);
  assert.deepEqual(
    transport.requests.map(({ input }) => input),
    [
      workerRequest("reconcile", { reference: reference() }),
      workerRequest("cancel", { reference: reference() }),
    ],
  );
});

test("fails closed on malformed and correlation-drifted responses", async () => {
  const transport = new ScriptedTransport();
  const client = protocol(transport);
  for (const body of [
    { nope: true },
    { ...success("execute"), operation: "cancel" },
    {
      ...success("execute"),
      resolution: { ...success("execute").resolution, executionId: "other" },
    },
  ]) {
    transport.response = responseOf(body);
    await assert.rejects(
      client.execute(routeIntent, command(), new AbortController().signal),
      hasError("workspace_read_gateway_response_invalid", "possiblySent"),
    );
  }
});

test("validates remote error envelopes and rejects status/content-type drift", async () => {
  const transport = new ScriptedTransport();
  const client = protocol(transport);
  transport.response = responseOf(
    {
      schemaVersion: "crewon.device-filesystem-read-dispatch-error.v0",
      apiVersion: 1,
      code: "device_unavailable",
      retryable: true,
      certainty: "notSent",
    },
    503,
  );
  await assert.rejects(
    client.reconcile(routeIntent, reference(), new AbortController().signal),
    hasError("device_unavailable", "notSent"),
  );

  transport.response = {
    ...responseOf(success("execute")),
    contentType: "text/plain",
  };
  await assert.rejects(
    client.execute(routeIntent, command(), new AbortController().signal),
    hasError("workspace_read_gateway_http_response_invalid", "possiblySent"),
  );
  transport.response = responseOf({ code: "unvalidated" }, 503);
  await assert.rejects(
    client.execute(routeIntent, command(), new AbortController().signal),
    hasError("workspace_read_gateway_error_invalid", "possiblySent"),
  );
});

test("aborts before transport with notSent certainty", async () => {
  const transport = new ScriptedTransport();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    protocol(transport).execute(routeIntent, command(), controller.signal),
    hasError("workspace_read_gateway_aborted", "notSent"),
  );
  assert.equal(transport.requests.length, 0);
});

test("crosses possible-send only after mTLS request construction and before body write", async () => {
  const deadline = new ManualDeadline();
  const controller = new AbortController();
  let options: RequestOptions | undefined;
  let bodyWrites = 0;
  const client = httpsClient({
    deadline,
    factory: (_endpoint, requestOptions) => {
      options = requestOptions;
      return requestPort({
        end() {
          bodyWrites += 1;
          controller.abort();
        },
      });
    },
  });

  await assert.rejects(
    client.execute(routeIntent, command(), controller.signal),
    hasError("workspace_read_gateway_aborted", "possiblySent"),
  );
  assert.equal(bodyWrites, 1);
  assert.equal(options?.agent instanceof Object, true);
  assert.equal(options?.path, "/worker/v1/device-filesystem-read-dispatch");
  assert.deepEqual(options?.headers, {
    "accept": "application/json",
    "content-length": String(
      Buffer.byteLength(
        JSON.stringify(workerRequest("execute", { command: command() })),
      ),
    ),
    "content-type": "application/json; charset=utf-8",
  });
  assert.equal(deadline.cancelCount, 1);
  await client.close();
});

test("keeps a cancel race lease-exact and classifies timeout after write as possiblySent", async () => {
  const deadline = new ManualDeadline();
  let written: any;
  const client = httpsClient({
    deadline,
    factory: () =>
      requestPort({
        end(body) {
          written = JSON.parse(Buffer.from(body).toString("utf8"));
          deadline.expire();
        },
      }),
  });
  await assert.rejects(
    client.cancel(routeIntent, reference(), new AbortController().signal),
    hasError("workspace_read_gateway_timeout", "possiblySent"),
  );
  assert.deepEqual(
    written,
    workerRequest("cancel", { reference: reference() }),
  );
  await client.close();
});

function protocol(transport: RuntimeWorkspaceReadGatewayTransportPort) {
  return new RuntimeWorkspaceReadGatewayProtocolClient(transport, {
    now: () => new Date("2026-08-08T00:00:00Z"),
  });
}
function command() {
  return structuredClone(fixture.valid.filesystemReadCommand);
}
function reference(): DeviceFilesystemReadDispatchReference {
  return {
    deviceId: "device-1",
    executionId: "execution-filesystem-1",
    workspaceBindingId: "workspace-opaque-1",
    incarnationId: "incarnation-1",
    deviceBindingId: routeIntent.deviceBindingId,
    runtimeBindingId: routeIntent.runtimeBindingId,
    actionDigest: command().actionDigest,
    commandDigest: terminal().commandDigest,
    leaseId: command().leaseId,
    leaseEpoch: command().leaseEpoch,
    receiptId: "receipt-read-1",
  };
}
function success(operation: "execute" | "reconcile" | "cancel") {
  return {
    schemaVersion: "crewon.device-filesystem-read-dispatch-response.v0",
    apiVersion: 1,
    operation,
    resolution: {
      status: "completed",
      executionId: "execution-filesystem-1",
      receiptId: "receipt-read-1",
      terminal: terminal(),
    } satisfies DeviceFilesystemReadDispatchResolution,
  };
}
function workerRequest(operation: string, target: Record<string, unknown>) {
  return {
    schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0",
    apiVersion: 1,
    routeIntent,
    operation,
    ...target,
  };
}
function terminal(): Extract<
  DeviceFilesystemReadEvent,
  { type: "workspace_read.completed" }
> {
  const event = fixture.valid.filesystemReadEvents[1];
  assert.equal(event?.type, "workspace_read.completed");
  return event as Extract<
    DeviceFilesystemReadEvent,
    { type: "workspace_read.completed" }
  >;
}
function responseOf(
  body: unknown,
  statusCode = 200,
): RuntimeWorkspaceReadGatewayHttpResponse {
  return {
    statusCode,
    contentType: "application/json; charset=utf-8",
    body: Buffer.from(JSON.stringify(body)),
  };
}
function hasError(code: string, certainty: "notSent" | "possiblySent") {
  return (error: unknown) => {
    assert.equal(error instanceof RuntimeWorkspaceReadGatewayClientError, true);
    assert.equal((error as RuntimeWorkspaceReadGatewayClientError).code, code);
    assert.equal(
      (error as RuntimeWorkspaceReadGatewayClientError).certainty,
      certainty,
    );
    return true;
  };
}

class ManualDeadline implements RuntimeWorkspaceReadDeadlineSchedulerPort {
  cancelCount = 0;
  #active = false;
  #callback: (() => void) | null = null;
  schedule(_delayMs: number, callback: () => void) {
    this.#active = true;
    this.#callback = callback;
    return () => {
      if (!this.#active) return;
      this.#active = false;
      this.cancelCount += 1;
    };
  }
  expire() {
    if (this.#active) this.#callback?.();
  }
}
function requestPort(overrides: { end(body: Uint8Array): void }) {
  const events = new EventEmitter();
  return {
    once(event: "error", listener: (error: Error) => void) {
      events.once(event, listener);
      return this;
    },
    setTimeout() {
      return this;
    },
    end: overrides.end,
    destroy(error?: Error) {
      if (error !== undefined) events.emit("error", error);
    },
  };
}
function httpsClient(input: {
  deadline: ManualDeadline;
  factory: RuntimeWorkspaceReadHttpsRequestFactory;
}) {
  return new HttpsRuntimeWorkspaceReadGatewayClient({
    endpoint: "https://gateway.internal",
    tls: {
      key: "worker-private-key",
      cert: "registered-worker-cert",
      ca: "gateway-ca",
    },
    now: () => new Date("2026-08-08T00:00:00Z"),
    requestFactory: input.factory,
    deadlineScheduler: input.deadline,
  });
}

void (null as RuntimeWorkspaceReadHttpsResponsePort | null);
