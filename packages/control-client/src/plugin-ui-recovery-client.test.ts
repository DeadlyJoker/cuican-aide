import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES,
  PLUGIN_UI_RECOVERY_VERSION,
  parsePluginUiRecoveryRequest,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const mountRef = "mount_" + "a".repeat(32);
const request = parsePluginUiRecoveryRequest({
  action: "crewon.project-generation-selections.v1.selectConceptImage",
  input: {
    reference: {
      projectId: "project",
      assetId: "asset",
      assetRevision: 2,
      expectedProjectRevision: 3,
      expectedAssetMetadataRevision: 4,
    },
    operationId: "00000000-0000-4000-8000-000000000123",
    expectedOperationRevision: 2,
    resultIndex: 1,
    expectedSelectionRevision: 0,
    idempotencyKey: "original-selection-key",
  },
}) as Extract<
  PluginUiRecoveryRequest,
  { action: "crewon.project-generation-selections.v1.selectConceptImage" }
>;
const intent = {
  sourcePin: {
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "8.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
    selectionRevision: 2,
    contributionId: "workbench",
  },
  request,
  revision: 1,
  phase: "prepared",
  dispatchMayHaveOccurred: false,
  dispatchAttemptCount: 0,
  receipt: null,
  retryable: true,
  reasonCode: null,
};
const hints = { version: PLUGIN_UI_RECOVERY_VERSION, intents: [intent] };
const staged = {
  version: PLUGIN_UI_RECOVERY_VERSION,
  disposition: "created",
  intent,
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
const invalidResponse = (error: unknown) =>
  error instanceof ControlApiProtocolError &&
  error.code === "control_client_plugin_response_invalid";
const invalidRequest = (error: unknown) =>
  error instanceof ControlApiProtocolError &&
  error.code === "control_client_plugin_request_invalid";

test("recovery uses the original authenticated finite transport and preserves the separate staging body", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = client(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json(init.method === "GET" ? hints : staged, {
      status: init.method === "GET" ? 200 : 201,
    });
  });
  const controller = new AbortController();
  const options = { signal: controller.signal };
  assert.deepEqual(await api.plugins.getRecovery(mountRef, options), hints);
  const ack = await api.plugins.stageRecovery(mountRef, request, options);
  assert.deepEqual(ack, staged);
  assert.ok(Object.isFrozen(ack.intent.request.input));
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      `https://control.test/api/v1/plugins/ui/mounts/${mountRef}/recovery`,
      `https://control.test/api/v1/plugins/ui/mounts/${mountRef}/recovery`,
    ],
  );
  assert.equal(calls[0]!.init.body, undefined);
  assert.equal(calls[1]!.init.body, JSON.stringify(request));
  for (const { init } of calls) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer actor-token");
    assert.equal(headers.get("origin"), "https://ui.test");
    assert.equal(headers.get("idempotency-key"), null);
    assert.equal(
      headers.get("x-csrf-token"),
      init.method === "GET" ? null : "csrf",
    );
    assert.equal(init.credentials, "include");
    assert.equal(init.redirect, "manual");
    assert.equal(init.signal, controller.signal);
  }
});

test("staging refuses authority, alternate actions, malformed mounts and getters before network I/O", async () => {
  let fetches = 0,
    reads = 0;
  const api = client(async () => {
    fetches++;
    return Response.json(staged);
  });
  for (const bad of [
    { ...request, actorId: "forged" },
    { ...request, sourcePin: intent.sourcePin },
    { ...request, phase: "accepted" },
    { ...request, input: { ...request.input, payerId: "forged" } },
    { action: "crewon.tasks.v1.createThread", input: {} },
    {
      get action() {
        reads++;
        return request.action;
      },
      input: request.input,
    },
  ]) {
    await assert.rejects(
      api.plugins.stageRecovery(mountRef, bad as typeof request),
      invalidRequest,
    );
  }
  await assert.rejects(
    api.plugins.getRecovery(`${mountRef}/../other`),
    invalidRequest,
  );
  assert.equal(fetches, 0);
  assert.equal(reads, 0);
});

test("staging ACK must match the exact original key, CAS and result index", async () => {
  for (const field of [
    "idempotencyKey",
    "expectedSelectionRevision",
    "resultIndex",
  ] as const) {
    const changed = {
      ...staged,
      intent: {
        ...intent,
        request: {
          ...request,
          input: {
            ...request.input,
            [field]: field === "idempotencyKey" ? "replacement" : 1,
          },
        },
      },
    };
    if (field === "resultIndex") changed.intent.request.input.resultIndex = 2;
    await assert.rejects(
      client(async () => Response.json(changed)).plugins.stageRecovery(
        mountRef,
        request,
      ),
      invalidResponse,
    );
  }
  for (const bad of [
    { ...staged, disposition: "committed" },
    { ...staged, intent: { ...intent, phase: "accepted" } },
    { ...staged, scope: { tenantId: "forged" } },
  ])
    await assert.rejects(
      client(async () => Response.json(bad)).plugins.stageRecovery(
        mountRef,
        request,
      ),
      invalidResponse,
    );
});

test("GET validates the hint family, finite body and public field boundary", async () => {
  for (const bad of [
    { ...hints, intents: [intent, intent] },
    { ...hints, intents: [{ ...intent, actorId: "forged" }] },
    { ...hints, version: "future" },
  ])
    await assert.rejects(
      client(async () => Response.json(bad)).plugins.getRecovery(mountRef),
      invalidResponse,
    );
  const oversized =
    " ".repeat(MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES) + JSON.stringify(hints);
  await assert.rejects(
    client(
      async () =>
        new Response(oversized, {
          headers: { "content-type": "application/json" },
        }),
    ).plugins.getRecovery(mountRef),
  );
});

test("GET needs no CSRF, staging needs it, and cancellation rejects a late ACK", async () => {
  let calls = 0;
  const noCsrf = client(async () => {
    calls++;
    return Response.json(hints);
  }, null);
  assert.deepEqual(await noCsrf.plugins.getRecovery(mountRef), hints);
  await assert.rejects(noCsrf.plugins.stageRecovery(mountRef, request));
  assert.equal(calls, 1);
  const controller = new AbortController();
  const api = client(async () => {
    controller.abort(new Error("cancelled after dispatch"));
    return Response.json(staged);
  });
  await assert.rejects(
    api.plugins.stageRecovery(mountRef, request, { signal: controller.signal }),
    /cancelled/,
  );
});

test("real conflict and redirect responses never become staging acknowledgements", async () => {
  await assert.rejects(
    client(async () =>
      Response.json(
        {
          error: {
            category: "conflict",
            code: "plugin_ui_intent_unresolved",
            requestId: "recovery-fixture",
          },
        },
        { status: 409 },
      ),
    ).plugins.stageRecovery(mountRef, request),
    (error: unknown) =>
      error instanceof ControlApiClientError && error.status === 409,
  );
  await assert.rejects(
    client(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.test" },
        }),
    ).plugins.stageRecovery(mountRef, request),
  );
});
