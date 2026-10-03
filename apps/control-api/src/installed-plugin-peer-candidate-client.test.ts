import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import {
  parseInstalledPluginPeerRequest,
  type InstalledPluginPeerPrepareCandidateRequest,
} from "@crewon/contracts/plugins";
import {
  InstalledPluginPeerClient,
  type InstalledPluginPeerCandidatePreparationInput,
} from "./installed-plugin-peer-client.ts";
import {
  candidateActor,
  candidateConfiguration,
  candidateDeferred,
  candidateDigester,
  candidateError,
  candidateIdentity,
  candidateInput,
  candidateRequest,
  candidateResponse,
  candidateScope,
  candidateTarget,
  candidateTransportConfiguration,
} from "./installed-plugin-peer-candidate.test-support.ts";

test("candidate uses real private HTTP directly without negotiating catalog or changing selection", async (t) => {
  const seen: InstalledPluginPeerPrepareCandidateRequest[] = [];
  const server = createServer(async (request, reply) => {
    assert.equal(request.url, "/private/v1/installed-plugins");
    assert.equal(request.method, "POST");
    assert.equal(
      request.headers.authorization,
      `Bearer ${candidateTransportConfiguration.token}`,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const parsed = parseInstalledPluginPeerRequest(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    assert.ok(parsed.operation === "prepareCandidate");
    seen.push(parsed);
    reply.writeHead(200, { "content-type": "application/json" });
    reply.end(JSON.stringify(candidateResponse(parsed)));
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  t.after(
    () =>
      new Promise<void>((yes) => {
        server.closeAllConnections();
        server.close(() => yes());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new InstalledPluginPeerClient({
    ...candidateTransportConfiguration,
    origin: `http://127.0.0.1:${address.port}`,
  });
  t.after(() => client.close());
  const result = await client.prepareCandidate(candidateInput);
  assert.deepEqual(result, { outcome: "ready", target: candidateTarget });
  assert.ok(Object.isFrozen(result));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.actor, candidateActor);
  assert.deepEqual(seen[0]?.scope, candidateScope);
  assert.deepEqual(seen[0]?.identity, candidateIdentity);
  assert.deepEqual(seen[0]?.configuration, candidateConfiguration);
  assert.deepEqual(seen[0]?.expectedTarget, candidateTarget);
  assert.equal(seen[0]?.expectedSelectionRevision, 4);
  assert.equal("runId" in result, false);
  assert.equal("activation" in result, false);
});

test("candidate snapshots nested caller values before the first asynchronous transport callback", async (t) => {
  let seen!: InstalledPluginPeerPrepareCandidateRequest;
  const client = new InstalledPluginPeerClient(
    candidateTransportConfiguration,
    {
      fetch: async (_, init) => {
        seen = candidateRequest(init);
        return Response.json(candidateResponse(seen));
      },
    },
  );
  t.after(() => client.close());
  const mutable = JSON.parse(
    JSON.stringify(candidateInput),
  ) as InstalledPluginPeerCandidatePreparationInput;
  const result = client.prepareCandidate(mutable);
  Object.assign(mutable.actor, { principalId: "changed-principal" });
  Object.assign(mutable.scope, { profileId: "changed-profile" });
  Object.assign(mutable.identity, {
    packageDigest: candidateDigester.sha256("changed-package"),
  });
  Object.assign(mutable.configuration.parameters, {
    endpoint: "https://changed.example",
  });
  Object.assign(mutable.expectedTarget, {
    materializationDigest: candidateDigester.sha256("changed-runtime"),
  });
  Object.assign(mutable, { expectedSelectionRevision: 5 });
  assert.deepEqual(await result, { outcome: "ready", target: candidateTarget });
  assert.deepEqual(seen.identity, candidateIdentity);
  assert.deepEqual(seen.configuration, candidateConfiguration);
  assert.deepEqual(seen.expectedTarget, candidateTarget);
  assert.equal(seen.expectedSelectionRevision, 4);
});

for (const reasonCode of [
  "extension_runtime_unavailable",
  "extension_implementation_unavailable",
  "extension_credential_unavailable",
  "extension_execution_authority_unsupported",
] as const)
  test(`candidate preserves unavailable result ${reasonCode} without trying another operation`, async (t) => {
    let calls = 0;
    const client = new InstalledPluginPeerClient(
      candidateTransportConfiguration,
      {
        fetch: async (_, init) => {
          calls++;
          return Response.json({
            ...candidateResponse(candidateRequest(init)),
            result: { outcome: "unavailable", reasonCode },
          });
        },
      },
    );
    t.after(() => client.close());
    assert.deepEqual(await client.prepareCandidate(candidateInput), {
      outcome: "unavailable",
      reasonCode,
    });
    assert.equal(calls, 1);
  });

const driftCases: readonly Readonly<{
  name: string;
  patch: (response: Record<string, unknown>) => Record<string, unknown>;
}>[] = [
  {
    name: "actor",
    patch: (response) => ({
      ...response,
      actor: { ...candidateActor, principalId: "other-principal" },
    }),
  },
  {
    name: "profile",
    patch: (response) => ({
      ...response,
      scope: { ...candidateScope, profileId: "other-profile" },
    }),
  },
  {
    name: "requestId",
    patch: (response) => ({ ...response, requestId: "other-request" }),
  },
  {
    name: "publisher",
    patch: (response) => ({
      ...response,
      identity: { ...candidateIdentity, publisherId: "other" },
    }),
  },
  {
    name: "package",
    patch: (response) => ({
      ...response,
      identity: {
        ...candidateIdentity,
        packageDigest: candidateDigester.sha256("other-package"),
      },
    }),
  },
  {
    name: "manifest",
    patch: (response) => ({
      ...response,
      identity: {
        ...candidateIdentity,
        manifestDigest: candidateDigester.sha256("other-manifest"),
      },
    }),
  },
  {
    name: "implementation",
    patch: (response) => ({
      ...response,
      identity: {
        ...candidateIdentity,
        implementationDigest: candidateDigester.sha256("other-implementation"),
      },
    }),
  },
  {
    name: "configuration",
    patch: (response) => ({
      ...response,
      configurationDigest: candidateDigester.sha256("other-configuration"),
    }),
  },
  {
    name: "selection revision",
    patch: (response) => ({ ...response, expectedSelectionRevision: 5 }),
  },
  {
    name: "expected target",
    patch: (response) => ({
      ...response,
      expectedTarget: { ...candidateTarget, policySnapshotId: "other-policy" },
    }),
  },
  {
    name: "ready target",
    patch: (response) => ({
      ...response,
      result: {
        outcome: "ready",
        target: {
          ...candidateTarget,
          materializationDigest: candidateDigester.sha256("other-runtime"),
        },
      },
    }),
  },
  {
    name: "legacy readiness operation",
    patch: (response) => {
      const { expectedSelectionRevision: _, ...legacy } = response;
      return { ...legacy, operation: "readiness" };
    },
  },
];
for (const fixture of driftCases)
  test(`candidate rejects ${fixture.name} response drift`, async (t) => {
    const client = new InstalledPluginPeerClient(
      candidateTransportConfiguration,
      {
        fetch: async (_, init) =>
          Response.json(
            fixture.patch(candidateResponse(candidateRequest(init))),
          ),
      },
    );
    t.after(() => client.close());
    await assert.rejects(
      client.prepareCandidate(candidateInput),
      candidateError("response_invalid"),
    );
  });

test("a peer that does not support candidate preparation is rejected without readiness or catalog fallback", async (t) => {
  const seen: string[] = [];
  const client = new InstalledPluginPeerClient(
    candidateTransportConfiguration,
    {
      fetch: async (_, init) => {
        seen.push(candidateRequest(init).operation);
        return Response.json(
          { error: "unsupported_operation" },
          { status: 400 },
        );
      },
    },
  );
  t.after(() => client.close());
  await assert.rejects(
    client.prepareCandidate(candidateInput),
    candidateError("unavailable"),
  );
  assert.deepEqual(seen, ["prepareCandidate"]);
});

test("candidate rejects mismatched actor, scope, configuration and target before HTTP dispatch", async (t) => {
  let calls = 0;
  const client = new InstalledPluginPeerClient(
    candidateTransportConfiguration,
    {
      fetch: async () => {
        calls++;
        throw new Error("must_not_dispatch");
      },
    },
  );
  t.after(() => client.close());
  const configFor = (patch: Record<string, unknown>) => {
    const { contentDigest: _, ...body } = candidateConfiguration;
    return createExtensionConfiguration(
      { ...body, ...patch },
      candidateDigester,
    );
  };
  for (const patch of [
    { scope: { ...candidateScope, tenantId: "other-tenant" } },
    { scope: { ...candidateScope, spaceId: "other-space" } },
    { configuration: configFor({ tenantId: "other-tenant" }) },
    { configuration: configFor({ spaceId: "other-space" }) },
    { configuration: configFor({ pluginId: "other.plugin" }) },
    { configuration: configFor({ pluginVersion: "2.0.0" }) },
    {
      configuration: configFor({
        manifestDigest: candidateDigester.sha256("other-manifest"),
      }),
    },
    {
      configuration: configFor({
        implementationDigest: candidateDigester.sha256("other-implementation"),
      }),
    },
  ])
    await assert.rejects(
      client.prepareCandidate({ ...candidateInput, ...patch }),
      candidateError("request_invalid"),
    );
  for (const patch of [
    { configuration: { ...candidateConfiguration, parameters: {} } },
    {
      expectedTarget: {
        ...candidateTarget,
        executionAuthority: "providerAgent",
      },
    },
    { expectedSelectionRevision: 0 },
    { expectedSelectionRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    await assert.rejects(
      client.prepareCandidate({
        ...candidateInput,
        ...patch,
      } as InstalledPluginPeerCandidatePreparationInput),
    );
  assert.equal(calls, 0);
});

test("candidate does not execute input getters and rejects unknown or nondata options before HTTP", async (t) => {
  let calls = 0,
    getterCalls = 0;
  const client = new InstalledPluginPeerClient(
    candidateTransportConfiguration,
    {
      fetch: async () => {
        calls++;
        throw new Error("must_not_dispatch");
      },
    },
  );
  t.after(() => client.close());
  const getter = { ...candidateInput };
  Object.defineProperty(getter, "expectedSelectionRevision", {
    enumerable: true,
    get: () => {
      getterCalls++;
      return 4;
    },
  });
  await assert.rejects(
    client.prepareCandidate(getter),
    candidateError("request_invalid"),
  );
  const nested = { ...candidateIdentity };
  Object.defineProperty(nested, "packageDigest", {
    enumerable: true,
    get: () => {
      getterCalls++;
      return candidateIdentity.packageDigest;
    },
  });
  await assert.rejects(
    client.prepareCandidate({ ...candidateInput, identity: nested }),
  );
  const options = Object.defineProperty({}, "signal", {
    enumerable: true,
    get: () => {
      getterCalls++;
      return undefined;
    },
  });
  await assert.rejects(
    client.prepareCandidate(candidateInput, options),
    candidateError("request_invalid"),
  );
  await assert.rejects(
    client.prepareCandidate({
      ...candidateInput,
      enabled: true,
    } as InstalledPluginPeerCandidatePreparationInput),
    candidateError("request_invalid"),
  );
  await assert.rejects(
    client.prepareCandidate(candidateInput, { signal: {} as AbortSignal }),
    candidateError("signal_invalid"),
  );
  assert.equal(getterCalls, 0);
  assert.equal(calls, 0);
});

test("candidate abort retains physical capacity and close waits for an ignored fetch and body cancellation", async (t) => {
  const entered = candidateDeferred<void>(),
    finish = candidateDeferred<Response>();
  const cancelling = candidateDeferred<void>(),
    finishCancel = candidateDeferred<void>();
  const controller = new AbortController();
  let signal!: AbortSignal,
    calls = 0;
  const client = new InstalledPluginPeerClient(
    { ...candidateTransportConfiguration, maximumRequests: 1 },
    {
      fetch: async (_, init) => {
        calls++;
        candidateRequest(init);
        signal = init?.signal as AbortSignal;
        entered.resolve();
        return finish.promise;
      },
    },
  );
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelling.resolve();
      return finishCancel.promise;
    },
  });
  const lateResponse = new Response(body);
  t.after(async () => {
    finish.resolve(lateResponse);
    finishCancel.resolve();
    await client.close();
  });
  const first = client
    .prepareCandidate(candidateInput, { signal: controller.signal })
    .then(
      () => null,
      (error: unknown) => error,
    );
  await entered.promise;
  controller.abort();
  assert.ok(candidateError("cancelled")(await first));
  assert.equal(signal.aborted, true);
  await assert.rejects(
    client.prepareCandidate(candidateInput),
    candidateError("capacity_exceeded"),
  );
  let closed = false;
  const closing = client.close().then(() => {
    closed = true;
  });
  finish.resolve(lateResponse);
  await cancelling.promise;
  await delay(5);
  assert.equal(closed, false);
  await assert.rejects(
    client.prepareCandidate(candidateInput),
    candidateError("closed"),
  );
  finishCancel.resolve();
  await closing;
  assert.equal(calls, 1);
  assert.equal(closed, true);
});

test("candidate deadline preserves ownership of a physical request until it settles", async (t) => {
  const entered = candidateDeferred<void>(),
    finish = candidateDeferred<Response>();
  let request!: InstalledPluginPeerPrepareCandidateRequest;
  const client = new InstalledPluginPeerClient(
    { ...candidateTransportConfiguration, deadlineMs: 10, maximumRequests: 1 },
    {
      fetch: async (_, init) => {
        request = candidateRequest(init);
        entered.resolve();
        return finish.promise;
      },
    },
  );
  t.after(async () => {
    finish.resolve(Response.json(candidateResponse(request)));
    await client.close();
  });
  const first = client.prepareCandidate(candidateInput).then(
    () => null,
    (error: unknown) => error,
  );
  await entered.promise;
  await delay(20);
  assert.ok(candidateError("deadline_exceeded")(await first));
  await assert.rejects(
    client.prepareCandidate(candidateInput),
    candidateError("capacity_exceeded"),
  );
  let closed = false;
  const closing = client.close().then(() => {
    closed = true;
  });
  await delay(5);
  assert.equal(closed, false);
  finish.resolve(Response.json(candidateResponse(request)));
  await closing;
});

test("candidate work is owned before a reentrant transport callback calls close", async () => {
  const entered = candidateDeferred<void>(),
    finish = candidateDeferred<Response>();
  let closing!: Promise<void>,
    request!: InstalledPluginPeerPrepareCandidateRequest,
    client!: InstalledPluginPeerClient;
  client = new InstalledPluginPeerClient(candidateTransportConfiguration, {
    fetch: async (_, init) => {
      request = candidateRequest(init);
      closing = client.close();
      entered.resolve();
      return finish.promise;
    },
  });
  try {
    const first = client.prepareCandidate(candidateInput).then(
      () => null,
      (error: unknown) => error,
    );
    await entered.promise;
    assert.ok(candidateError("closed")(await first));
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await delay(5);
    assert.equal(closed, false);
  } finally {
    finish.resolve(Response.json(candidateResponse(request)));
    await client.close();
  }
});

test("candidate pre-aborted signal never dispatches a private request", async (t) => {
  let calls = 0;
  const client = new InstalledPluginPeerClient(
    candidateTransportConfiguration,
    {
      fetch: async () => {
        calls++;
        throw new Error("must_not_dispatch");
      },
    },
  );
  t.after(() => client.close());
  const controller = new AbortController();
  controller.abort(new Error("fixture_withdrawn"));
  await assert.rejects(
    client.prepareCandidate(candidateInput, { signal: controller.signal }),
    /fixture_withdrawn/u,
  );
  assert.equal(calls, 0);
});
