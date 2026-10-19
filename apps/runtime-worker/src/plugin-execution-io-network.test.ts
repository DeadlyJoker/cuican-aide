import assert from "node:assert/strict";
import test from "node:test";
import {
  captureNetworkApproval,
  ioJson,
  ioPath,
  PluginExecutionJsonHttp,
  PluginExecutionIoHttpResourceError,
  type PluginIoHttpRequest,
} from "./plugins/plugin-execution-io-network.ts";
import type { NetworkDnsResolver } from "./network-egress.ts";
import type {
  PinnedHttpPort,
  PinnedHttpRequest,
  PinnedHttpResponse,
} from "./pinned-node-http.ts";

const identity = {
  baseUrl: "https://api.example:8443/",
  tenantId: "tenant-1",
  bindingId: "binding-1",
};
const publicDns: NetworkDnsResolver = {
  resolveAll: async () => [{ address: "8.8.8.8", family: 4 }],
};
const ok: PinnedHttpResponse = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from('{"ok":true}'),
};
const signal = () => new AbortController().signal;
const allowed = async () => {};

test("404/410 resources produce a terminal typed error without exposing bodies; 429/500 remain recoverable", async () => {
  for (const status of [404, 410, 429, 500]) {
    let sends = 0;
    const http = new PluginExecutionJsonHttp({
      ...identity,
      dns: publicDns,
      transport: {
        request: async () => {
          sends++;
          return {
            ...ok,
            status,
            body: Buffer.from("<html>private provider body</html>"),
          };
        },
      },
    });
    await assert.rejects(
      http.request(
        { method: "GET", path: "/history/original" },
        signal(),
        allowed,
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error instanceof PluginExecutionIoHttpResourceError,
          status === 404 || status === 410,
        );
        assert.equal(
          error.message,
          status === 404 || status === 410
            ? `plugin_execution_io_http_${status}`
            : "plugin_execution_io_http_failed",
        );
        return true;
      },
    );
    assert.equal(sends, 1);
  }
});

test("plugin HTTP requires a root HTTPS origin without URL credentials and valid scoped network identity", () => {
  for (const baseUrl of [
    "http://api.example/",
    "file:///tmp/api",
    "not a URL",
    "https://user:secret@api.example/",
    "https://%75ser@api.example/",
    "https://api.example/api/",
    "https://api.example/?key=secret",
    "https://api.example/#fragment",
    " https://api.example/",
    "https://api.example/\n",
    "https://api.\nexample/",
  ])
    assert.throws(
      () => new PluginExecutionJsonHttp({ ...identity, baseUrl }),
      /service_url_invalid/,
    );
  for (const value of ["", " invalid", "id\u0000", "x".repeat(513)]) {
    assert.throws(
      () => new PluginExecutionJsonHttp({ ...identity, tenantId: value }),
      /network_binding_invalid/,
    );
    assert.throws(
      () => new PluginExecutionJsonHttp({ ...identity, bindingId: value }),
      /network_binding_invalid/,
    );
  }
});

test("approved network metadata is detached, bounded, and narrows operation routes to exact GET prefixes", () => {
  const input = {
    baseUrlParameter: "serviceUrl",
    paths: [
      { method: "POST", path: "/prompt" },
      { method: "GET", operationPathPrefix: "/history/" },
    ],
  };
  const approval = captureNetworkApproval(input);
  input.paths[0]!.path = "/interrupt";
  assert.equal((approval.paths[0] as { path: string }).path, "/prompt");
  assert.ok(Object.isFrozen(approval.paths));
  for (const value of [
    { ...input, paths: [] },
    {
      ...input,
      paths: Array.from({ length: 33 }, () => ({
        method: "GET",
        path: "/queue",
      })),
    },
    { ...input, baseUrlParameter: "owner[secret]" },
    { ...input, paths: [{ method: "POST", operationPathPrefix: "/history/" }] },
    {
      ...input,
      paths: [{ method: "GET", operationPathPrefix: "/history/?id=&all=" }],
    },
    { ...input, paths: [{ method: "GET", operationPathPrefix: "/history" }] },
    {
      ...input,
      paths: [
        { method: "GET", path: "/queue", operationPathPrefix: "/history/" },
      ],
    },
    { ...input, paths: [{ method: "DELETE", path: "/queue" }] },
  ])
    assert.throws(
      () => captureNetworkApproval(value),
      /network_approval_invalid/,
    );
});

test("path traversal, other origins, URL credentials, fragments and control characters never reach DNS", async () => {
  let dns = 0,
    sends = 0;
  const http = new PluginExecutionJsonHttp({
    ...identity,
    dns: {
      resolveAll: async () => {
        dns++;
        return publicDns.resolveAll("api.example");
      },
    },
    transport: {
      request: async () => {
        sends++;
        return ok;
      },
    },
  });
  for (const path of [
    "https://evil.example/",
    "//evil.example/",
    "//user:secret@evil.example/",
    "/history/../prompt",
    "/history/%2e%2e/prompt",
    "/history/.%2E/prompt",
    "/queue#token",
    "/history\\prompt",
    "/queue\n",
    "/ queue",
    "queue",
    "/" + "x".repeat(2048),
  ]) {
    assert.throws(() => ioPath(path), /path_invalid/);
    await assert.rejects(
      http.request({ method: "GET", path }, signal(), allowed),
      /path_invalid/,
    );
  }
  assert.equal(dns, 0);
  assert.equal(sends, 0);
});

test("GET body, unknown methods/fields and request accessors fail before any DNS or transport call", async () => {
  let getters = 0,
    dns = 0;
  const http = new PluginExecutionJsonHttp({
    ...identity,
    dns: {
      resolveAll: async () => {
        dns++;
        return publicDns.resolveAll("api.example");
      },
    },
    transport: { request: async () => assert.fail("must not dispatch") },
  });
  for (const request of [
    { method: "GET", path: "/queue", body: {} },
    { method: "DELETE", path: "/queue" },
    { method: "GET", path: "/queue", authorization: "Bearer private" },
    Object.defineProperty({ method: "GET", path: "/queue" }, "body", {
      enumerable: true,
      get() {
        getters++;
        return {};
      },
    }),
    Object.defineProperty({ method: "GET" }, "path", {
      enumerable: true,
      get() {
        getters++;
        return "/queue";
      },
    }),
    Object.defineProperty({ path: "/queue" }, "method", {
      enumerable: true,
      get() {
        getters++;
        return "GET";
      },
    }),
  ])
    await assert.rejects(
      http.request(request as PluginIoHttpRequest, signal(), allowed),
      /(?:request|input)_invalid/,
    );
  assert.equal(getters, 0);
  assert.equal(dns, 0);
});

test("pure JSON rejects hooks, accessors, nonfinite values, cycles, sparse/custom arrays and illegal Unicode without evaluating hooks", () => {
  let hooks = 0;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      hooks++;
      return "private";
    },
  });
  const hook = {
    toJSON() {
      hooks++;
      return {};
    },
  };
  const array: unknown[] = [];
  Object.setPrototypeOf(array, {
    toJSON() {
      hooks++;
      return [];
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = new Array(2);
  sparse[1] = "exists";
  const hidden = Object.defineProperty({}, "hidden", { value: 1 });
  for (const value of [
    getter,
    hook,
    array,
    cyclic,
    sparse,
    hidden,
    { [Symbol("hidden")]: true },
    NaN,
    Infinity,
    -Infinity,
    1n,
    undefined,
    new Date(),
    "\ud800",
    "\udc00",
    { "\ud800": true },
  ])
    assert.throws(() => ioJson(value, 256), /json_invalid/);
  assert.equal(hooks, 0);
});

test("JSON UTF8 budgets include punctuation/escaping and stop before visiting later data", () => {
  const value = { 中: ["😀", "\n", "\\", '"', "\u0000", -0, 1e-8] };
  const encoded = JSON.stringify(value);
  const size = Buffer.byteLength(encoded);
  assert.deepEqual(ioJson(value, size), JSON.parse(encoded));
  assert.throws(() => ioJson(value, size - 1), /json_limit/);
  let visited = 0;
  const probe = new Proxy(
    {},
    {
      getPrototypeOf() {
        visited++;
        return Object.prototype;
      },
    },
  );
  assert.throws(
    () => ioJson(["x".repeat(12), "x".repeat(12), probe], 25),
    /json_limit/,
  );
  assert.equal(visited, 0);
  const mutable = { prompt: { text: "original" } };
  const detached = ioJson(mutable, 256);
  mutable.prompt.text = "changed";
  assert.deepEqual(detached, { prompt: { text: "original" } });
});

test("overbudget or impure POST JSON is rejected before resolving the configured origin", async () => {
  let dns = 0,
    hooks = 0;
  const http = new PluginExecutionJsonHttp({
    ...identity,
    dns: {
      resolveAll: async () => {
        dns++;
        return publicDns.resolveAll("api.example");
      },
    },
    transport: { request: async () => assert.fail("must not dispatch") },
  });
  const accessor = Object.defineProperty({}, "prompt", {
    enumerable: true,
    get() {
      hooks++;
      return {};
    },
  });
  for (const body of ["x".repeat(128 * 1024), { nested: Infinity }, accessor])
    await assert.rejects(
      http.request(
        { method: "POST", path: "/prompt", body: body as never },
        signal(),
        allowed,
      ),
      /json_(?:invalid|limit)/,
    );
  assert.equal(dns, 0);
  assert.equal(hooks, 0);
});

test("production egress denies private/loopback/mixed DNS before permission callback or pinned transport", async () => {
  for (const addresses of [
    ["127.0.0.1"],
    ["10.0.0.1"],
    ["169.254.169.254"],
    ["::1"],
    ["::ffff:127.0.0.1"],
    ["8.8.8.8", "10.0.0.1"],
  ]) {
    let sends = 0,
      approvals = 0;
    const http = new PluginExecutionJsonHttp({
      ...identity,
      dns: {
        resolveAll: async () =>
          addresses.map((address) => ({
            address,
            family: address.includes(":") ? (6 as const) : (4 as const),
          })),
      },
      transport: {
        request: async () => {
          sends++;
          return ok;
        },
      },
    });
    await assert.rejects(
      http.request({ method: "GET", path: "/queue" }, signal(), async () => {
        approvals++;
      }),
      /egress_denied/,
    );
    assert.equal(sends, 0);
    assert.equal(approvals, 0);
  }
});

test("permission revoked while actual production DNS resolves is checked after DNS and sends zero requests", async () => {
  let resolve!: (
    value: Awaited<ReturnType<NetworkDnsResolver["resolveAll"]>>,
  ) => void;
  const dns = new Promise<
    Awaited<ReturnType<NetworkDnsResolver["resolveAll"]>>
  >((done) => {
    resolve = done;
  });
  let entered!: () => void;
  const pending = new Promise<void>((done) => {
    entered = done;
  });
  let allowedNow = true,
    sends = 0;
  const http = new PluginExecutionJsonHttp({
    ...identity,
    dns: {
      resolveAll: async () => {
        entered();
        return dns;
      },
    },
    transport: {
      request: async () => {
        sends++;
        return ok;
      },
    },
  });
  const request = http.request(
    { method: "POST", path: "/prompt", body: {} },
    signal(),
    async () => {
      if (!allowedNow) throw new Error("fixture_current_permission_revoked");
    },
  );
  await pending;
  allowedNow = false;
  resolve([{ address: "8.8.8.8", family: 4 }]);
  await assert.rejects(request, /current_permission_revoked/);
  assert.equal(sends, 0);
});

test("a captured request cannot change destination/method/body while DNS or authorization is pending", async () => {
  const events: string[] = [];
  const requests: PinnedHttpRequest[] = [];
  const mutable = {
    method: "POST" as "POST" | "GET",
    path: "/prompt",
    body: { text: "original" },
  };
  const http = new PluginExecutionJsonHttp({
    ...identity,
    dns: {
      resolveAll: async () => {
        events.push("dns");
        mutable.method = "GET";
        mutable.path = "/interrupt";
        mutable.body.text = "changed";
        return publicDns.resolveAll("api.example");
      },
    },
    transport: {
      request: async (request, signal) => {
        events.push("send");
        assert.equal(signal.aborted, false);
        requests.push(request);
        return ok;
      },
    },
  });
  assert.deepEqual(
    await http.request(mutable, signal(), async () => {
      events.push("gate");
    }),
    { ok: true },
  );
  assert.deepEqual(events, ["dns", "gate", "send"]);
  assert.equal(requests[0]!.method, "POST");
  assert.equal(
    requests[0]!.target.endpoint.href,
    "https://api.example:8443/prompt",
  );
  assert.equal(requests[0]!.target.address, "8.8.8.8");
  assert.equal(
    Buffer.from(requests[0]!.body!).toString(),
    '{"text":"original"}',
  );
  assert.equal(requests[0]!.headers?.authorization, undefined);
  assert.equal(requests[0]!.maxRequestBytes, 128 * 1024);
  assert.equal(requests[0]!.maxResponseBytes, 1024 * 1024);
});

test("abort from the post-DNS permission gate rejects transport but an already received response remains usable evidence", async () => {
  const abort = new AbortController();
  let sends = 0;
  const http = new PluginExecutionJsonHttp({
    ...identity,
    dns: publicDns,
    transport: {
      request: async () => {
        sends++;
        return ok;
      },
    },
  });
  await assert.rejects(
    http.request({ method: "GET", path: "/queue" }, abort.signal, async () => {
      abort.abort(new Error("revoked_after_dns"));
    }),
    /revoked_after_dns/,
  );
  assert.equal(sends, 0);
  const received = new AbortController();
  const accepted = new PluginExecutionJsonHttp({
    ...identity,
    dns: publicDns,
    transport: {
      request: async () => {
        received.abort(new Error("late_abort"));
        return ok;
      },
    },
  });
  assert.deepEqual(
    await accepted.request(
      { method: "POST", path: "/prompt", body: {} },
      received.signal,
      allowed,
    ),
    { ok: true },
  );
});

test("redirects, non-success statuses, oversized/invalid UTF8 JSON and nonfinite response numbers never trigger retry or leak provider bodies", async () => {
  for (const response of [
    { ...ok, status: 302, headers: { location: "https://private.example/" } },
    { ...ok, status: 500, body: Buffer.from("provider-private-message") },
    { ...ok, body: Buffer.alloc(1024 * 1024 + 1) },
    { ...ok, body: Buffer.from("not-json-provider-private-message") },
    { ...ok, body: Buffer.from([0xff]) },
    { ...ok, body: Buffer.from("1e1000") },
    { ...ok, body: Buffer.from('"\\ud800"') },
  ]) {
    let sends = 0;
    const transport: PinnedHttpPort = {
      request: async () => {
        sends++;
        return response;
      },
    };
    const http = new PluginExecutionJsonHttp({
      ...identity,
      dns: publicDns,
      transport,
    });
    await assert.rejects(
      http.request(
        { method: "POST", path: "/prompt", body: {} },
        signal(),
        allowed,
      ),
      (error: unknown) =>
        error instanceof Error &&
        /(?:http_failed|response_(?:limit|invalid)|json_invalid)/.test(
          error.message,
        ) &&
        !error.message.includes("provider-private-message"),
    );
    assert.equal(sends, 1);
  }
});
