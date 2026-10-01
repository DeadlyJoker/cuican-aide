import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionHostRequest } from "@crewon/contracts";
import { parseExtensionHostResponse } from "@crewon/contracts";
import {
  extensionHostFixture,
  hostActor,
} from "./extension-host.test-support.ts";
import { startRuntimeExtensionHostServer } from "./extensions/extension-host-server.ts";

const token = "private-extension-host-token-at-least-32-bytes";
const catalog = {
  protocol: "crewon.extension-host-request.v0",
  operation: "catalog",
  actor: hostActor,
};
function catalogResponse(request: ExtensionHostRequest) {
  return {
    protocol: "crewon.extension-host-response.v0" as const,
    operation: "catalog" as const,
    actor: request.actor,
    registrations: [],
  };
}
function post(origin: string, body: unknown, overrides: RequestInit = {}) {
  return fetch(`${origin}/private/v0/extensions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...overrides,
  });
}

test("the private route serves real catalog, configuration and actual kernel readiness", async (t) => {
  const f = await extensionHostFixture(t);
  const server = await startRuntimeExtensionHostServer({
    port: 0,
    token,
    service: f.service,
  });
  t.after(() => server.close());
  const { agentVersionId: _, ...configured } = f.request;
  for (const request of [
    catalog,
    { ...configured, operation: "validateConfiguration" },
    f.request,
  ]) {
    const response = await post(server.origin, request);
    assert.equal(response.status, 200);
    const parsed = parseExtensionHostResponse(await response.json());
    assert.equal(parsed.operation, request.operation);
    assert.deepEqual(parsed.actor, hostActor);
    if (parsed.operation === "readiness")
      assert.deepEqual(parsed.result, { outcome: "ready", target: f.target });
  }
  assert.equal(f.controls.toolsConstructed, 1);
  assert.equal(f.controls.released, 1);
});

test("routing, bearer authentication, current identity and strict bounded payloads precede runtime construction", async (t) => {
  const f = await extensionHostFixture(t);
  const server = await startRuntimeExtensionHostServer({
    port: 0,
    token,
    service: f.service,
  });
  t.after(() => server.close());
  assert.equal((await fetch(`${server.origin}/wrong`)).status, 404);
  assert.equal(
    (await fetch(`${server.origin}/private/v0/extensions`)).status,
    404,
  );
  assert.equal(
    (
      await post(server.origin, catalog, {
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer wrong",
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await post(server.origin, {
        ...catalog,
        actor: { ...hostActor, principalId: "forged" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post(server.origin, {
        ...catalog,
        actor: { ...hostActor, principalId: hostActor.actorId },
      })
    ).status,
    403,
  );
  for (const body of [
    { ...catalog, operation: "execute" },
    { ...catalog, route: "/prompt" },
    { ...catalog, extra: "a".repeat(131073) },
  ])
    assert.equal((await post(server.origin, body)).status, 400);
  assert.equal(
    (await post(server.origin, catalog, { body: "{not json" })).status,
    400,
  );
  assert.equal(
    (
      await post(server.origin, catalog, {
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "text/plain",
        },
      })
    ).status,
    400,
  );
  assert.equal(f.controls.toolsConstructed, 0);
});

test("concurrency and per-window request limits bound private work", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = await startRuntimeExtensionHostServer({
    port: 0,
    token,
    concurrencyLimit: 1,
    service: {
      handle: async (request) => {
        entered();
        await waiting;
        return catalogResponse(request as ExtensionHostRequest);
      },
    },
  });
  t.after(() => server.close());
  const pending = post(server.origin, catalog);
  await started;
  assert.equal((await post(server.origin, catalog)).status, 429);
  finish();
  assert.equal((await pending).status, 200);
  const limited = await startRuntimeExtensionHostServer({
    port: 0,
    token,
    rateLimit: 1,
    service: {
      handle: async (request) =>
        catalogResponse(request as ExtensionHostRequest),
    },
  });
  t.after(() => limited.close());
  assert.equal((await post(limited.origin, catalog)).status, 200);
  assert.equal((await post(limited.origin, catalog)).status, 429);
});

test("close cancels the logical request and waits for physical host ownership to finish", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let signal: AbortSignal | undefined;
  const server = await startRuntimeExtensionHostServer({
    port: 0,
    token,
    service: {
      handle: async (request, cancellation) => {
        signal = cancellation;
        entered();
        await waiting;
        return catalogResponse(request as ExtensionHostRequest);
      },
    },
  });
  const pending = post(server.origin, catalog);
  const observed = pending.catch(() => null);
  await started;
  let closed = false;
  const closing = server.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal?.aborted, true);
  assert.equal(
    closed,
    false,
    "physical readiness may still own a resolver lease",
  );
  finish();
  await closing;
  await observed;
  assert.equal(closed, true);
});

test("a disconnected request retains its concurrency slot until physical host work settles", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = await startRuntimeExtensionHostServer({
    port: 0,
    token,
    concurrencyLimit: 1,
    service: {
      handle: async (request, signal) => {
        signal.addEventListener("abort", aborted, { once: true });
        entered();
        await waiting;
        return catalogResponse(request as ExtensionHostRequest);
      },
    },
  });
  t.after(() => server.close());
  const controller = new AbortController();
  const request = post(server.origin, catalog, {
    signal: controller.signal,
  }).catch(() => null);
  await started;
  controller.abort();
  await disconnected;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await post(server.origin, catalog)).status, 429);
  finish();
  await request;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await post(server.origin, catalog)).status, 200);
});

test("invalid service replies fail closed and listener configuration is bounded", async (t) => {
  const server = await startRuntimeExtensionHostServer({
    port: 0,
    token,
    service: {
      handle: async (request) => ({
        ...catalogResponse(request as ExtensionHostRequest),
        actor: { ...hostActor, principalId: "other" },
      }),
    },
  });
  t.after(() => server.close());
  assert.equal((await post(server.origin, catalog)).status, 503);
  for (const patch of [
    { port: -1 },
    { token: "short" },
    { deadlineMs: 999 },
    { concurrencyLimit: 0 },
    { rateLimit: 1001 },
  ])
    await assert.rejects(
      startRuntimeExtensionHostServer({
        port: 0,
        token,
        service: {
          handle: async (request) =>
            catalogResponse(request as ExtensionHostRequest),
        },
        ...patch,
      }),
      /extension_host_server_configuration_invalid/u,
    );
});
