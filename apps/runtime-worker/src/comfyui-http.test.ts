import assert from "node:assert/strict";
import test from "node:test";
import { ProductionComfyHttp } from "./extensions/comfyui-http.ts";
import type { PinnedHttpPort, PinnedHttpRequest } from "./pinned-node-http.ts";

const signal = () => new AbortController().signal;
const identity = {
  baseUrl: "https://comfy.example:8443/",
  tenantId: "tenant-1",
  bindingId: "binding-1",
};
const publicDns = {
  resolveAll: async () => [{ address: "8.8.8.8", family: 4 as const }],
};
const ok = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from("{}"),
};

test("Comfy production HTTP pins public HTTPS and bounds each request without credentials", async () => {
  const requests: PinnedHttpRequest[] = [];
  const http = new ProductionComfyHttp({
    ...identity,
    dns: publicDns,
    transport: {
      request: async (input, signal) => {
        assert.equal(signal.aborted, false);
        requests.push(input);
        return ok;
      },
    },
  });
  assert.deepEqual(
    await http.request({
      method: "POST",
      path: "/prompt",
      body: { prompt: {} },
      signal: signal(),
    }),
    {},
  );
  const request = requests[0]!;
  assert.equal(request.target.address, "8.8.8.8");
  assert.equal(
    request.target.endpoint.href,
    "https://comfy.example:8443/prompt",
  );
  assert.equal(request.headers?.authorization, undefined);
  assert.equal(request.maxRequestBytes, 128 * 1024);
  assert.equal(request.maxResponseBytes, 1024 * 1024);
});

test("Comfy production HTTP rejects path escapes, global control and unbounded payloads before DNS", async () => {
  const http = new ProductionComfyHttp({
    ...identity,
    dns: { resolveAll: async () => assert.fail("must not resolve") },
  });
  for (const path of [
    "https://evil.example/",
    "//evil.example/prompt",
    "/interrupt",
    "/queue?clear=true",
    "/history/../prompt",
  ]) {
    await assert.rejects(
      http.request({ method: "GET", path, signal: signal() }),
      /request_not_allowed/u,
    );
    await assert.rejects(
      http.request({ method: "POST", path, body: {}, signal: signal() }),
      /request_not_allowed/u,
    );
  }
  await assert.rejects(
    http.request({
      method: "POST",
      path: "/prompt",
      body: "x".repeat(128 * 1024),
      signal: signal(),
    }),
    /request_too_large/u,
  );
  for (const baseUrl of [
    "http://comfy.example/",
    "https://user:secret@comfy.example/",
    "https://comfy.example/base/",
    "https://comfy.example/?token=secret",
  ]) {
    assert.throws(
      () => new ProductionComfyHttp({ ...identity, baseUrl }),
      /service_url_invalid/u,
    );
  }
});

test("Comfy production HTTP rejects private or mixed DNS answers before transport", async () => {
  for (const addresses of [["127.0.0.1"], ["8.8.8.8", "10.0.0.1"]]) {
    const http = new ProductionComfyHttp({
      ...identity,
      dns: {
        resolveAll: async () =>
          addresses.map((address) => ({ address, family: 4 as const })),
      },
      transport: { request: async () => assert.fail("must not send") },
    });
    await assert.rejects(
      http.request({ method: "GET", path: "/queue", signal: signal() }),
      /egress_denied/u,
    );
  }
});

test("Comfy production HTTP does not follow redirects, retry POST or expose provider error bodies", async () => {
  for (const response of [
    { ...ok, status: 302, headers: { location: "https://evil.example/" } },
    { ...ok, status: 500, body: Buffer.from("provider-private-error") },
    { ...ok, body: Buffer.from("not json") },
    { ...ok, body: Buffer.alloc(1024 * 1024 + 1) },
  ]) {
    let sends = 0;
    const transport: PinnedHttpPort = {
      request: async () => {
        sends++;
        return response;
      },
    };
    const http = new ProductionComfyHttp({
      ...identity,
      dns: publicDns,
      transport,
    });
    await assert.rejects(
      http.request({
        method: "POST",
        path: "/prompt",
        body: {},
        signal: signal(),
      }),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes("provider-private-error"),
    );
    assert.equal(sends, 1);
  }
});
