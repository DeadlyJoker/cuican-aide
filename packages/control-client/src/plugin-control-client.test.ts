import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
  MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES,
  MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const pluginId = "fixture.plugin";
const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const ref = "mount_" + "a".repeat(32);
const pkg = {
  pluginId,
  version: "1.0.0",
  publisherId: "fixture.publisher",
  packageDigest: digest,
  installedAt: "2026-10-01T00:00:00.000Z",
};
const selection = {
  pluginId,
  publisherId: pkg.publisherId,
  revision: 1,
  state: "disabled",
  selectedPackageDigest: digest,
  updatedAt: pkg.installedAt,
} as const;
const descriptor = {
  schemaVersion: "crewon.plugin-package.v1",
  hostApi: "crewon.plugin-host.v1",
  pluginId,
  version: pkg.version,
  title: "Fixture",
  description: "Transport fixture",
  publisherId: pkg.publisherId,
  entrypoints: {
    node: null,
    ui: { path: "dist/entry.mjs", mode: "trustedModule" },
  },
  businessManifestPath: null,
  requires: [],
  provides: [],
  contributions: [
    { id: "workbench", kind: "module", slot: "main.content", title: "Fixture" },
  ],
  files: [{ path: "dist/entry.mjs", byteLength: 1, sha256: "c".repeat(64) }],
} as const;
const lease = {
  schemaVersion: "crewon.plugin-ui-lease.v1",
  mountRef: ref,
  expiresAt: "2030-01-01T00:00:00.000Z",
  selectionRevision: 2,
  packageDigest: digest,
  descriptor,
  contributionId: "workbench",
  publicAssets: ["dist/entry.mjs"],
} as const;
const installation = {
  sourceId: "source:opaque",
  expectedPluginId: pluginId,
  expectedPackageDigest: digest,
  expectedSelectionRevision: null,
};
const installResult = {
  kind: "install",
  disposition: "committed",
  package: pkg,
  selection,
};
const change = {
  state: "enabled",
  selectedPackageDigest: digest,
  expectedSelectionRevision: 1,
} as const;
const selectResult = {
  mutation: {
    kind: "select",
    disposition: "committed",
    selection: { ...selection, revision: 2, state: "enabled" },
  },
  projection: { outcome: "applied" },
};
const open = {
  pluginId,
  contributionId: "workbench",
  expectedSelectionRevision: 2,
  expectedPackageDigest: digest,
};

function client(
  fetch: typeof globalThis.fetch,
  csrfToken: string | null = "csrf",
) {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "actor-token",
    origin: "https://ui.test",
    csrfToken,
    fetch,
  });
}
function invalid(error: unknown) {
  return (
    error instanceof ControlApiProtocolError &&
    error.code === "control_client_plugin_response_invalid"
  );
}

test("eleven methods share the original authenticated transport, exact paths, CSRF and abort", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const responses: unknown[] = [
    { packages: [pkg], next: null },
    { package: pkg },
    installResult,
    { selections: [selection], next: null },
    { selection },
    selectResult,
    {
      plugins: [
        {
          descriptor,
          selectionRevision: 2,
          packageDigest: digest,
          publicAssets: lease.publicAssets,
        },
      ],
      next: null,
    },
    lease,
    lease,
    { closed: true },
    { output: { accepted: true } },
  ];
  const controller = new AbortController();
  const api = client(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json(responses.shift());
  });
  assert.equal(api.plugins, api.plugins);
  const options = { signal: controller.signal };
  assert.deepEqual(
    await api.plugins.listPackages({ pluginId, limit: 2 }, options),
    { packages: [pkg], next: null },
  );
  assert.deepEqual(await api.plugins.getPackage(digest, options), {
    package: pkg,
  });
  assert.deepEqual(
    await api.plugins.installPackage(installation, "install-once", options),
    installResult,
  );
  assert.deepEqual(await api.plugins.listSelections({ limit: 2 }, options), {
    selections: [selection],
    next: null,
  });
  assert.deepEqual(await api.plugins.getSelection(pluginId, options), {
    selection,
  });
  assert.deepEqual(
    await api.plugins.setSelection(pluginId, change, "select-once", options),
    selectResult,
  );
  assert.deepEqual(
    (await api.plugins.uiCatalog({ limit: 2 }, options)).plugins[0]?.descriptor,
    descriptor,
  );
  assert.deepEqual(await api.plugins.openMount(open, options), lease);
  assert.deepEqual(await api.plugins.validateMount(ref, options), lease);
  assert.deepEqual(await api.plugins.closeMount(ref, options), {
    closed: true,
  });
  assert.deepEqual(
    await api.plugins.invoke(
      ref,
      {
        action: "creative.appendBrief",
        input: { text: "中文\n".repeat(1000) },
      },
      options,
    ),
    { output: { accepted: true } },
  );
  const base = "https://control.test/api/v1/plugins";
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      `${base}/packages?pluginId=${pluginId}&limit=2`,
      `${base}/packages/${encodeURIComponent(digest)}`,
      `${base}/installations`,
      `${base}/selections?limit=2`,
      `${base}/selections/${pluginId}`,
      `${base}/selections/${pluginId}`,
      `${base}/ui/catalog?limit=2`,
      `${base}/ui/mounts`,
      `${base}/ui/mounts/${ref}`,
      `${base}/ui/mounts/${ref}`,
      `${base}/ui/mounts/${ref}/actions`,
    ],
  );
  for (const { init } of calls) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer actor-token");
    assert.equal(headers.get("origin"), "https://ui.test");
    assert.equal(init.credentials, "include");
    assert.equal(init.redirect, "manual");
    assert.equal(init.signal, controller.signal);
    assert.equal(
      headers.get("x-csrf-token"),
      init.method === "GET" ? null : "csrf",
    );
    if (init.method === "GET") assert.equal(init.body, undefined);
    if (init.method === "DELETE") assert.equal(init.body, "{}");
  }
  assert.deepEqual(
    calls.map(({ init }) => new Headers(init.headers).get("idempotency-key")),
    [
      null,
      null,
      "install-once",
      null,
      null,
      "select-once",
      null,
      null,
      null,
      null,
      null,
    ],
  );
  for (const { init } of calls)
    if (init.body !== undefined)
      assert.equal(String(init.body).includes("actorId"), false);
});

test("filtered UI catalog pages preserve authoritative next even when no UI item is visible", async () => {
  const paths: string[] = [];
  const responses = [
    { plugins: [], next: "fixture.disabled" },
    {
      plugins: [
        {
          descriptor,
          selectionRevision: 2,
          packageDigest: digest,
          publicAssets: lease.publicAssets,
        },
      ],
      next: null,
    },
  ];
  const api = client(async (url) => {
    paths.push(String(url));
    return Response.json(responses.shift());
  });
  const first = await api.plugins.uiCatalog({ limit: 1 });
  assert.deepEqual(first, { plugins: [], next: "fixture.disabled" });
  const second = await api.plugins.uiCatalog({
    afterPluginId: first.next,
    limit: 1,
  });
  assert.equal(second.plugins.length, 1);
  assert.deepEqual(paths, [
    "https://control.test/api/v1/plugins/ui/catalog?limit=1",
    "https://control.test/api/v1/plugins/ui/catalog?afterPluginId=fixture.disabled&limit=1",
  ]);
});

test("all response identities and immutable expected mount fields fail closed", async () => {
  const cases: [unknown, (api: ControlApiClient) => Promise<unknown>][] = [
    [
      { packages: [{ ...pkg, pluginId: "other.plugin" }], next: null },
      (api) => api.plugins.listPackages({ pluginId }),
    ],
    [
      { package: { ...pkg, packageDigest: otherDigest } },
      (api) => api.plugins.getPackage(digest),
    ],
    [
      { ...installResult, package: { ...pkg, pluginId: "other.plugin" } },
      (api) => api.plugins.installPackage(installation, "key"),
    ],
    [
      { selections: [selection, selection], next: null },
      (api) => api.plugins.listSelections(),
    ],
    [
      { selection: { ...selection, pluginId: "other.plugin" } },
      (api) => api.plugins.getSelection(pluginId),
    ],
    [
      {
        ...selectResult,
        mutation: {
          ...selectResult.mutation,
          selection: { ...selection, revision: 2, state: "disabled" },
        },
      },
      (api) => api.plugins.setSelection(pluginId, change, "key"),
    ],
    [
      { plugins: [], next: "fixture.a" },
      (api) => api.plugins.uiCatalog({ afterPluginId: "fixture.z" }),
    ],
    [
      { ...lease, contributionId: "other" },
      (api) => api.plugins.openMount(open),
    ],
    [{ ...lease, selectionRevision: 3 }, (api) => api.plugins.openMount(open)],
    [
      { ...lease, packageDigest: otherDigest },
      (api) => api.plugins.openMount(open),
    ],
    [
      { ...lease, mountRef: "b".repeat(32) },
      (api) => api.plugins.validateMount(ref),
    ],
    [
      { closed: true, actorId: "private" },
      (api) => api.plugins.closeMount(ref),
    ],
    [
      { output: {}, private: "secret" },
      (api) => api.plugins.invoke(ref, { action: "safe", input: null }),
    ],
  ];
  for (const [response, run] of cases)
    await assert.rejects(
      run(client(async () => Response.json(response))),
      invalid,
    );
});

test("install and selection receipt snapshots may replay while retaining submitted CAS and exact quote-free DTO", async () => {
  const api = client(async (url) =>
    Response.json(
      String(url).endsWith("/installations")
        ? { ...installResult, disposition: "replayed" }
        : {
            ...selectResult,
            mutation: { ...selectResult.mutation, disposition: "replayed" },
            projection: { outcome: "unchanged" },
          },
    ),
  );
  assert.equal(
    (await api.plugins.installPackage(installation, "old-key")).disposition,
    "replayed",
  );
  assert.equal(
    (await api.plugins.setSelection(pluginId, change, "old-key")).mutation
      .disposition,
    "replayed",
  );
});

test("request validation rejects identity fields, accessors, invalid limits and unsafe JSON before fetch", async () => {
  let fetches = 0;
  let getterReads = 0;
  const api = client(async () => {
    fetches++;
    return Response.json({});
  });
  const accessor = Object.defineProperty({}, "action", {
    enumerable: true,
    get() {
      getterReads++;
      return "safe";
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const calls = [
    () => api.plugins.listPackages({ limit: 0 }),
    () => api.plugins.listPackages({ principalId: "other" } as never),
    () => api.plugins.listSelections({ limit: 1.5 }),
    () => api.plugins.uiCatalog({ limit: "20" } as never),
    () => api.plugins.getPackage("sha256:INVALID"),
    () => api.plugins.getSelection("../other"),
    () =>
      api.plugins.installPackage(
        { ...installation, profileId: "other" } as never,
        "key",
      ),
    () => api.plugins.installPackage(installation, ""),
    () =>
      api.plugins.setSelection(
        pluginId,
        { ...change, state: "uninstalled" } as never,
        "key",
      ),
    () => api.plugins.openMount({ ...open, actorId: "other" } as never),
    () => api.plugins.validateMount("short"),
    () => api.plugins.closeMount("../other"),
    () => api.plugins.invoke(ref, accessor as never),
    () => api.plugins.invoke(ref, { action: "safe", input: cycle } as never),
    () => api.plugins.invoke(ref, { action: "safe", input: NaN } as never),
    () =>
      api.plugins.invoke(ref, { action: "safe", input: "x".repeat(24 * 1024) }),
  ];
  for (const run of calls)
    await assert.rejects(run(), {
      code: "control_client_plugin_request_invalid",
    });
  assert.equal(fetches, 0);
  assert.equal(getterReads, 0);
});

test("HTTP idempotency keys reject Unicode, Latin-1 and whitespace before constructing headers", async () => {
  let fetches = 0;
  const api = client(async () => {
    fetches++;
    return Response.json({});
  });
  for (const key of [
    "😀",
    "中文",
    "\u00a0",
    "\u00ff",
    "café",
    "has space",
    " leading",
    "trailing ",
    "inner\tspace",
  ]) {
    await assert.rejects(api.plugins.installPackage(installation, key), {
      code: "control_client_plugin_request_invalid",
    });
    await assert.rejects(api.plugins.setSelection(pluginId, change, key), {
      code: "control_client_plugin_request_invalid",
    });
  }
  assert.equal(fetches, 0);
});

test("request snapshots detach commands, JSON input and cursor context before transport observes them", async () => {
  const install = { ...installation };
  const action = { action: "safe", input: { text: "original" } };
  const query = { pluginId, limit: 1 };
  let body: unknown;
  const api = client(async (url, init = {}) => {
    body = init.body === undefined ? null : JSON.parse(String(init.body));
    if (String(url).endsWith("/installations"))
      install.expectedPluginId = "other.plugin";
    else if (String(url).includes("/actions")) action.input.text = "changed";
    else query.pluginId = "other.plugin";
    return Response.json(
      String(url).endsWith("/installations")
        ? installResult
        : String(url).includes("/actions")
          ? { output: {} }
          : { packages: [pkg], next: null },
    );
  });
  assert.equal(
    (await api.plugins.installPackage(install, "key")).package.pluginId,
    pluginId,
  );
  assert.deepEqual(body, installation);
  await api.plugins.invoke(ref, action);
  assert.deepEqual(body, { action: "safe", input: { text: "original" } });
  assert.equal(
    (await api.plugins.listPackages(query)).packages[0]?.pluginId,
    pluginId,
  );
});

test("mutations require the original CSRF transport but UI actions do not invent idempotency", async () => {
  let fetches = 0;
  const api = client(async () => {
    fetches++;
    return Response.json({});
  }, null);
  for (const run of [
    () => api.plugins.installPackage(installation, "key"),
    () => api.plugins.setSelection(pluginId, change, "key"),
    () => api.plugins.openMount(open),
    () => api.plugins.closeMount(ref),
    () => api.plugins.invoke(ref, { action: "safe", input: null }),
  ])
    await assert.rejects(run(), { code: "control_client_csrf_token_required" });
  assert.equal(fetches, 0);
});

test("finite response limits cancel oversized streams for metadata, lease and catalog methods", async () => {
  for (const [limit, run] of [
    [
      MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
      (api: ControlApiClient) => api.plugins.getSelection(pluginId),
    ],
    [
      MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES,
      (api: ControlApiClient) => api.plugins.openMount(open),
    ],
    [
      MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES,
      (api: ControlApiClient) => api.plugins.uiCatalog(),
    ],
  ] as const) {
    let cancelled = false;
    const api = client(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(limit + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    await assert.rejects(run(api), {
      code: "control_client_workspace_response_too_large",
    });
    assert.equal(cancelled, true);
  }
});

test("abort before dispatch or during a delayed transport cannot return a stale parsed receipt", async () => {
  let fetches = 0;
  const controller = new AbortController();
  controller.abort();
  const api = client(async () => {
    fetches++;
    return Response.json({ package: pkg });
  });
  await assert.rejects(
    api.plugins.getPackage(digest, { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(fetches, 0);
  const pendingController = new AbortController();
  const delayed = client(async (_url, init = {}) => {
    assert.equal(init.signal, pendingController.signal);
    pendingController.abort();
    return Response.json({ package: pkg });
  });
  await assert.rejects(
    delayed.plugins.getPackage(digest, { signal: pendingController.signal }),
    { name: "AbortError" },
  );
});

test("public Control errors pass through unchanged and close rejects 204 rather than inventing a receipt", async () => {
  const denied = client(async () =>
    Response.json(
      {
        error: {
          category: "authorization",
          code: "plugin_ui_denied",
          requestId: "request-1",
        },
      },
      { status: 403 },
    ),
  );
  await assert.rejects(
    denied.plugins.openMount(open),
    (error: unknown) =>
      error instanceof ControlApiClientError &&
      error.status === 403 &&
      error.code === "plugin_ui_denied",
  );
  const noContent = client(async () => new Response(null, { status: 204 }));
  await assert.rejects(noContent.plugins.closeMount(ref));
});
