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

test("rejects non-HTTPS and path-bearing endpoints without following redirects", () => {
  for (const endpoint of [
    "http://gateway.internal",
    "https://gateway.internal/redirect-target",
  ]) {
    assert.throws(
      () =>
        new NodeHttpsDeviceWorkspaceListDispatchTransport({
          endpoint,
          tls: { key: "key", cert: "cert", ca: "ca" },
        }),
      hasError("device_workspace_dispatch_endpoint_invalid", "notSent"),
    );
  }
});

test("classifies factory failure before write as notSent", async () => {
  const transport = new NodeHttpsDeviceWorkspaceListDispatchTransport({
    endpoint: "https://gateway.internal",
    tls: { key: "key", cert: "cert", ca: "ca" },
    requestFactory: () => {
      throw new Error("factory failed");
    },
  });
  await assert.rejects(
    transport.post(Buffer.from("{}"), new AbortController().signal, 1_000),
    hasError("device_workspace_dispatch_transport_failed", "notSent"),
  );
  transport.close();
});

test("classifies abort after crossing the request.end boundary as possiblySent", async () => {
  const controller = new AbortController();
  let ended = false;
  const transport = new NodeHttpsDeviceWorkspaceListDispatchTransport({
    endpoint: "https://gateway.internal",
    tls: { key: "key", cert: "cert", ca: "ca" },
    requestFactory: () =>
      fakeRequest(() => {
        ended = true;
      }),
  });
  const pending = transport.post(Buffer.from("{}"), controller.signal, 1_000);
  assert.equal(ended, true);
  controller.abort();
  await assert.rejects(
    pending,
    hasError("device_workspace_dispatch_aborted", "possiblySent"),
  );
  transport.close();
});

test("enforces a total deadline even while response bytes keep arriving", async () => {
  const deadline = new ManualDeadlineScheduler();
  const response = manualResponse();
  let requestDestroyCount = 0;
  let idleTimeout: (() => void) | undefined;
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
        setTimeout(_timeoutMs, callback) {
          idleTimeout = callback;
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
  const pending = transport.post(
    Buffer.from("{}"),
    new AbortController().signal,
    1_000,
  );
  response.events.emit("data", Buffer.from("{"));
  response.events.emit("data", Buffer.from('"status"'));
  response.events.emit("data", Buffer.from(":"));
  assert.notEqual(idleTimeout, undefined);

  deadline.expire();

  await assert.rejects(
    pending,
    hasError("device_workspace_dispatch_transport_timeout", "possiblySent"),
  );
  assert.equal(requestDestroyCount, 1);
  assert.equal(deadline.cancelCount, 1);
  transport.close();
});

test("rejects an oversized response after write with possiblySent certainty", async () => {
  const transport = new NodeHttpsDeviceWorkspaceListDispatchTransport({
    endpoint: "https://gateway.internal",
    tls: { key: "key", cert: "cert", ca: "ca" },
    requestFactory: (_endpoint, _options, onResponse) =>
      fakeRequest(() => {
        onResponse(
          fakeResponse(Buffer.alloc(0), {
            "content-length": String(128 * 1024 + 1),
          }),
        );
      }),
  });
  await assert.rejects(
    transport.post(Buffer.from("{}"), new AbortController().signal, 1_000),
    hasError("device_workspace_dispatch_response_too_large", "possiblySent"),
  );
  transport.close();
});
