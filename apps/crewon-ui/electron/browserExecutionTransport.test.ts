import { createHash } from "node:crypto";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalActionIntent, type ActionIntent } from "@crewon/contracts";
import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
} from "@crewon/tool-broker";
import {
  startBrowserExecutionTransport,
  type BrowserExecutionTransportHost,
} from "./browserExecutionTransport.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("BrowserExecutionTransport", () => {
  it("serves authenticated original commands and bounded binary files on one random loopback address", async () => {
    const calls: unknown[] = [];
    const server = await start({
      execute: async (command) => {
        calls.push(command);
        return completed();
      },
      download: async (command, receiptId) => {
        calls.push({ command, receiptId });
        return new Uint8Array([0, 128, 255]);
      },
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]+$/);
    expect(server.token).toMatch(/^[a-f0-9]{64}$/);
    const first = await post(server, "execute", { command: command() });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(completed());
    const file = await post(server, "download", {
      command: command(),
      receiptId: "receipt-1",
    });
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array([0, 128, 255]),
    );
    expect(calls).toEqual([
      command(),
      { command: command(), receiptId: "receipt-1" },
    ]);
  });

  it("rejects Origin, missing/wrong tokens, wrong method/path/host/content type and body extensions before host calls", async () => {
    let called = 0;
    const server = await start({
      execute: async () => {
        called++;
        return completed();
      },
    });
    for (const [path, options, status] of [
      ["execute", { headers: { origin: "https://attacker.test" } }, 403],
      ["execute", { headers: { authorization: "" } }, 401],
      [
        "execute",
        { headers: { authorization: "Bearer " + "b".repeat(64) } },
        401,
      ],
      ["execute", { method: "OPTIONS", body: undefined }, 405],
      ["execute", { method: "GET", body: undefined }, 405],
      ["execute?bypass=1", {}, 404],
      ["other", {}, 404],
      ["execute", { headers: { "content-type": "text/plain" } }, 415],
      [
        "execute",
        { body: JSON.stringify({ command: command(), code: "eval" }) },
        400,
      ],
      [
        "execute",
        {
          body: JSON.stringify({
            command: { ...command(), input: "tampered" },
          }),
        },
        400,
      ],
      [
        "download",
        {
          body: JSON.stringify({ command: command(), receiptId: "../secret" }),
        },
        400,
      ],
    ] as const) {
      const response = await post(
        server,
        path,
        { command: command() },
        options,
      );
      expect(response.status, `${path} ${JSON.stringify(options)}`).toBe(
        status,
      );
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.text()).not.toContain(server.token);
    }
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const client = request(
        `${server.url}/v1/browser/execute`,
        {
          method: "POST",
          headers: {
            "authorization": `Bearer ${server.token}`,
            "content-type": "application/json",
            "host": "attacker.test",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      client.on("error", reject);
      client.end(JSON.stringify({ command: command() }));
    });
    expect(hostStatus).toBe(403);
    expect(called).toBe(0);
  });

  it("bounds streamed request bodies and both model output bytes and serialized envelopes", async () => {
    let result = completed("界".repeat(3072));
    const server = await start({ execute: async () => result });
    const valid = await post(server, "execute", { command: command() });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual(result);
    result = completed("界".repeat(3073));
    expect((await post(server, "execute", { command: command() })).status).toBe(
      502,
    );
    result = completed("\n".repeat(9216));
    expect((await post(server, "execute", { command: command() })).status).toBe(
      502,
    );
    const oversized = await post(
      server,
      "execute",
      {},
      { body: "x".repeat(32769) },
    );
    expect(oversized.status).toBe(413);
    const streamedStatus = await new Promise<number>((resolve, reject) => {
      const client = request(
        `${server.url}/v1/browser/execute`,
        {
          method: "POST",
          headers: {
            "authorization": `Bearer ${server.token}`,
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      client.on("error", reject);
      client.write("x".repeat(20000));
      client.end("y".repeat(13000));
    });
    expect(streamedStatus).toBe(413);
  });

  it("cancels a dispatched action once when its caller disconnects and never dispatches it again", async () => {
    let started!: () => void;
    const startSignal = new Promise<void>((resolve) => {
      started = resolve;
    });
    let canceled!: () => void;
    const canceledSignal = new Promise<void>((resolve) => {
      canceled = resolve;
    });
    let executions = 0;
    let cancels = 0;
    const server = await start({
      execute: () => {
        executions++;
        started();
        return new Promise(() => {});
      },
      cancel: async (value) => {
        expect(value).toEqual(command());
        cancels++;
        canceled();
        return canceledResult();
      },
    });
    const abort = new AbortController();
    const pending = post(
      server,
      "execute",
      { command: command() },
      { signal: abort.signal },
    ).catch(() => null);
    await startSignal;
    abort.abort();
    await canceledSignal;
    expect(await pending).toBeNull();
    expect(executions).toBe(1);
    expect(cancels).toBe(1);
  });

  it("keeps one cancellation slot while normal requests reach capacity", async () => {
    let count = 0;
    let ready!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release!: (result: ToolExecutionResolution) => void;
    const pendingHost = new Promise<ToolExecutionResolution>((resolve) => {
      release = resolve;
    });
    const server = await start({
      execute: () => {
        if (++count === 7) ready();
        return pendingHost;
      },
    });
    const pending = Array.from({ length: 7 }, () =>
      post(server, "execute", { command: command() }),
    );
    await allStarted;
    try {
      expect(
        (await post(server, "execute", { command: command() })).status,
      ).toBe(429);
      const canceled = await post(server, "cancel", { command: command() });
      expect(canceled.status).toBe(200);
      expect(await canceled.json()).toEqual(canceledResult());
    } finally {
      release(completed());
      await Promise.all(pending);
    }
  });

  it("close ends active connections, notifies cancellation and is idempotent without closing the host", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancels = 0;
    const server = await start({
      execute: () => {
        started();
        return new Promise(() => {});
      },
      cancel: async () => {
        cancels++;
        return canceledResult();
      },
    });
    const pending = post(server, "execute", { command: command() }).catch(
      () => null,
    );
    await ready;
    await server.close();
    await server.close();
    expect(await pending).toBeNull();
    expect(cancels).toBe(1);
    await expect(
      post(server, "execute", { command: command() }),
    ).rejects.toThrow();
  });

  it("rejects over-limit binary downloads and mismatched response identities", async () => {
    const server = await start({
      download: async () => new Uint8Array(10485761),
      reconcile: async () => ({ ...completed(), executionId: "other" }),
    });
    expect(
      (
        await post(server, "download", {
          command: command(),
          receiptId: "receipt-1",
        })
      ).status,
    ).toBe(502);
    expect(
      (await post(server, "reconcile", { command: command() })).status,
    ).toBe(502);
  });

  it("times out an unfinished request body without dispatching an action", async () => {
    let executions = 0;
    const server = await start({
      execute: async () => {
        executions++;
        return completed();
      },
    });
    const began = Date.now();
    const status = await new Promise<number>((resolve, reject) => {
      const client = request(
        `${server.url}/v1/browser/execute`,
        {
          method: "POST",
          headers: {
            "authorization": `Bearer ${server.token}`,
            "content-type": "application/json",
            "content-length": "100",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
          client.destroy();
        },
      );
      client.on("error", reject);
      client.flushHeaders();
      client.write("{");
    });
    expect([408, 504]).toContain(status);
    expect(Date.now() - began).toBeLessThan(4500);
    expect(executions).toBe(0);
  });
});

async function start(overrides: Partial<BrowserExecutionTransportHost> = {}) {
  const server = await startBrowserExecutionTransport({
    execute: async () => completed(),
    reconcile: async () => completed(),
    cancel: async () => canceledResult(),
    download: async () => new Uint8Array(),
    ...overrides,
  });
  closers.push(server.close);
  return server;
}
function post(
  server: { url: string; token: string },
  operation: string,
  value: unknown,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
) {
  const body = Object.hasOwn(options, "body")
    ? options.body
    : JSON.stringify(value);
  return fetch(`${server.url}/v1/browser/${operation}`, {
    ...options,
    method: options.method ?? "POST",
    headers: {
      "authorization": `Bearer ${server.token}`,
      "content-type": "application/json",
      ...options.headers,
    },
    body,
  });
}
function command(): ToolExecutionCommand {
  const input = "{}";
  const actionIntent: ActionIntent = {
    schemaVersion: "crewon.action-intent.v0",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: {
      kind: "function",
      name: "crewon_browser_observe",
      inputDigest: sha256(input),
    },
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
    effect: "readOnly",
    recovery: "replaySafe",
    resourceBindingId: "desktop-browser",
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "desktop-browser" },
    capability: "browser.observe.v1",
    approvalRequirement: "none",
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: 9216,
      maxArtifactBytes: 10485760,
    },
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    idempotencyKey: "key-1",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    kind: "function",
    name: "crewon_browser_observe",
    input,
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
  };
}
function sha256(input: string) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
function completed(
  output = "{}",
): Extract<ToolExecutionResolution, { status: "completed" }> {
  return {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: "call-1",
      output,
      isError: false,
      artifactRef: null,
    },
  };
}
function canceledResult(): ToolExecutionResolution {
  return {
    status: "canceled",
    executionId: "execution-1",
    providerReceiptId: null,
  };
}
