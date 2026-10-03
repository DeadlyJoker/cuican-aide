import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import {
  INSTALLED_PLUGIN_PEER_PRIVATE_PATH,
  INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  type InstalledPluginPeerRequest,
} from "@crewon/contracts/plugins";
import { RuntimeCompositionLifetime } from "./runtime-composition-lifetime.ts";
import { ownInstalledPluginPeerStop } from "./plugins/installed-plugin-peer-composition.ts";
import { InstalledPluginPeerService } from "./plugins/installed-plugin-peer-service.ts";
import { startInstalledPluginPeerServer } from "./plugins/installed-plugin-peer-server.ts";
import {
  captureInstalledPluginPeerConfig,
  resolveInstalledPluginPeerEnvironment,
} from "./plugins/installed-plugin-peer-environment.ts";
import {
  actor,
  digester,
  gate,
  peerFixture,
  post,
  token,
} from "./installed-plugin-peer.test-support.ts";

test("the installed peer is default off, strictly opt-in and redacts its private token", () => {
  assert.equal(resolveInstalledPluginPeerEnvironment({}), undefined);
  const config = resolveInstalledPluginPeerEnvironment({
    CREWON_INSTALLED_PLUGIN_PEER_PORT: "0",
    CREWON_INSTALLED_PLUGIN_PEER_TOKEN: token,
  })!;
  assert.equal(config.deadlineMs, 10000);
  assert.equal(JSON.stringify(config).includes(token), false);
  assert.equal(inspect(config).includes(token), false);
  for (const environment of [
    { CREWON_INSTALLED_PLUGIN_PEER_PORT: "0" },
    { CREWON_INSTALLED_PLUGIN_PEER_TOKEN: token },
    { CREWON_INSTALLED_PLUGIN_PEER_DEADLINE_MS: "1000" },
    {
      CREWON_INSTALLED_PLUGIN_PEER_PORT: "1e3",
      CREWON_INSTALLED_PLUGIN_PEER_TOKEN: token,
    },
    {
      CREWON_INSTALLED_PLUGIN_PEER_PORT: "0",
      CREWON_INSTALLED_PLUGIN_PEER_TOKEN: token,
      CREWON_INSTALLED_PLUGIN_PEER_DEADLINE_MS: "999",
    },
  ])
    assert.throws(
      () => resolveInstalledPluginPeerEnvironment(environment),
      /configuration_invalid/,
    );
  let reads = 0;
  assert.throws(
    () =>
      captureInstalledPluginPeerConfig({
        port: 0,
        deadlineMs: 1000,
        get token() {
          reads++;
          return token;
        },
      }),
    /configuration_invalid/,
  );
  assert.equal(reads, 0);
});

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 60_000,
  };
  test(
    `${backend}: private generation readiness uses the actual installed package, profile and configured full target without provider dispatch`,
    options,
    async (t) => {
      const f = await peerFixture(t, backend);
      const beforeCatalog = f.state.preflights;
      const catalog = await f.invoke(f.common("catalog"));
      assert.equal(catalog.operation, "catalog");
      if (catalog.operation !== "catalog")
        throw new Error("unexpected_response");
      assert.deepEqual(catalog.entries, [
        {
          identity: f.identity(),
          manifest: f.release.registrations[0]!.manifest,
          configuration: f.entries[0]!.configuration,
          configuredTarget: f.entries[0]!.target,
        },
      ]);
      assert.equal(
        f.state.preflights,
        beforeCatalog,
        "catalog metadata grants no readiness",
      );
      const configured = await f.invoke(f.request("validateConfiguration"));
      assert.equal(configured.operation, "validateConfiguration");
      const ready = await f.invoke(f.request("readiness"));
      assert.equal(ready.operation, "readiness");
      if (ready.operation !== "readiness")
        throw new Error("unexpected_response");
      assert.deepEqual(ready.result, {
        outcome: "ready",
        target: f.entries[0]!.target,
      });
      assert.ok(f.state.preflights > 0);
      assert.equal(f.state.http, 0);
      assert.equal(f.state.quotes, 0);
      f.state.ioAllowed = false;
      const unavailable = await f.invoke(f.request("readiness"));
      assert.equal(unavailable.operation, "readiness");
      if (unavailable.operation === "readiness")
        assert.equal(unavailable.result.outcome, "unavailable");
      for (const changed of [
        { actor: { ...actor, principalId: "forged-principal" } },
        { scope: { ...f.scope, profileId: "wrong-profile" } },
        { identity: { ...f.identity(), publisherId: "forged-publisher" } },
        {
          identity: {
            ...f.identity(),
            packageDigest: digester.sha256("wrong-package"),
          },
        },
        {
          expectedTarget: {
            ...f.entries[0]!.target,
            policySnapshotId: "wrong-policy",
          },
        },
      ])
        assert.equal(
          (await post(f.peer.origin, { ...f.request("readiness"), ...changed }))
            .status,
          403,
        );
      await f.select("disabled");
      const hidden = await f.invoke(f.common("catalog"));
      assert.equal(hidden.operation, "catalog");
      if (hidden.operation === "catalog") assert.deepEqual(hidden.entries, []);
      assert.notEqual(
        (await post(f.peer.origin, f.request("readiness"))).status,
        200,
      );
    },
  );
  test(
    `${backend}: historical query reloads the paid original source and retains A after a real selected-B upgrade/disable`,
    options,
    async (t) => {
      const f = await peerFixture(t, backend, 2);
      const source = await f.paidSource();
      const savedCredit = await f.store
        .extensionStore()
        .loadExtensionCreditAdmission(source.binding);
      assert.equal(savedCredit?.reservation.quotedCredits, "30");
      assert.equal(
        savedCredit?.reservation.scope.principalId,
        actor.principalId,
      );
      const query = {
        ...f.common("queryReadiness"),
        identity: f.identity(),
        configuration: f.entries[0]!.configuration,
        expectedTarget: f.entries[0]!.target,
        expectedSource: source,
      };
      const resolve = {
        ...f.common("queryResolveRegistration"),
        expectedSource: source,
      };
      await f.select("enabled", f.entries[1]!.packageIdentity.packageDigest);
      const beforeBMetadata = f.state.preflights;
      const upgradeMetadata = await f.invoke(f.common("catalog"));
      if (upgradeMetadata.operation !== "catalog")
        throw new Error("unexpected_response");
      assert.equal(upgradeMetadata.entries.length, 1);
      assert.deepEqual(upgradeMetadata.entries[0]!.identity, f.identity(1));
      assert.equal(
        f.state.preflights,
        beforeBMetadata,
        "selected B is metadata until actual readiness is requested",
      );
      const oldActivation = await f.store
        .extensionStore()
        .loadExtensionActivation({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          pluginId: f.identity().pluginId,
        });
      assert.deepEqual(oldActivation?.target, f.entries[0]!.target);
      await f.activate(1);
      const readyB = await f.invoke(f.request("readiness", 1));
      if (readyB.operation !== "readiness")
        throw new Error("unexpected_response");
      assert.deepEqual(readyB.result, {
        outcome: "ready",
        target: f.entries[1]!.target,
      });
      const current = await f.invoke(f.common("catalog"));
      if (current.operation !== "catalog")
        throw new Error("unexpected_response");
      assert.equal(current.entries[0]!.identity.version, "2.0.0");
      for (const disabled of [false, true]) {
        if (disabled)
          await f.select(
            "disabled",
            f.entries[1]!.packageIdentity.packageDigest,
          );
        const original = await f.invoke(resolve);
        assert.equal(original.operation, "queryResolveRegistration");
        if (original.operation !== "queryResolveRegistration")
          throw new Error("unexpected_response");
        assert.deepEqual(original.registration?.identity, f.identity());
        assert.deepEqual(original.expectedSource, source);
        const ready = await f.invoke(query);
        if (ready.operation !== "queryReadiness")
          throw new Error("unexpected_response");
        assert.deepEqual(ready.result, {
          outcome: "ready",
          target: f.entries[0]!.target,
        });
      }
      assert.equal(
        f.state.quotes,
        1,
        "query peer does not reserve a second hold",
      );
      assert.equal(
        f.state.http,
        0,
        "query readiness does not issue GET or POST",
      );
      assert.deepEqual(
        await f.store
          .extensionStore()
          .loadExtensionCreditAdmission(source.binding),
        savedCredit,
      );
      assert.notEqual(
        (await post(f.peer.origin, { ...query, identity: f.identity(1) }))
          .status,
        200,
      );
      assert.notEqual(
        (
          await post(f.peer.origin, {
            ...resolve,
            expectedSource: {
              ...source,
              admission: {
                ...source.admission,
                authorityEpoch: "client-forged-epoch",
              },
            },
          })
        ).status,
        200,
      );
      f.state.permissionAllowed = false;
      assert.equal((await post(f.peer.origin, resolve)).status, 403);
    },
  );
}

test("unbranded Loaded copies cannot instantiate the peer", async (t) => {
  const f = await peerFixture(t);
  assert.throws(
    () =>
      new InstalledPluginPeerService({
        release: { ...f.release },
        store: f.store,
        runtimeResolver: f.resolver,
        execution: f.execution,
        resolveProfile: f.resolveProfile,
      }),
    /unverified_document/,
  );
});

test("an authority callback that reenters close remains physically joined by the peer", async (t) => {
  const f = await peerFixture(t);
  const entered = gate(),
    physical = gate();
  let closing: Promise<void> | null = null;
  let nested: Promise<void> | null = null;
  let closed = false;
  const service = new InstalledPluginPeerService({
    release: f.release,
    store: f.store,
    runtimeResolver: f.resolver,
    execution: {
      ...f.execution,
      async resolveActor(_owner, signal) {
        signal.addEventListener(
          "abort",
          () => {
            nested = service.close();
          },
          { once: true },
        );
        closing = service.close();
        void closing.then(() => {
          closed = true;
        });
        entered.resolve();
        await physical.promise;
        return actor;
      },
    },
    resolveProfile: f.resolveProfile,
  });
  t.after(() => {
    physical.resolve();
    return service.close();
  });
  const pending = service.handle(
    f.common("catalog"),
    new AbortController().signal,
  );
  const rejected = assert.rejects(pending, /closed/);
  await entered.promise;
  assert.equal(
    nested,
    closing,
    "abort-listener reentrancy joins the same memoized shutdown",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  physical.resolve();
  await rejected;
  await closing;
  assert.equal(closed, true);
});

test("missing and withdrawn business activation keeps selected installed metadata available for the real management path", async (t) => {
  const f = await peerFixture(t, "sqlite", 1, { activate: false });
  assert.equal(
    await f.store.extensionStore().loadExtensionActivation({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: f.identity().pluginId,
    }),
    null,
  );
  const metadata = await f.invoke(f.common("catalog"));
  if (metadata.operation !== "catalog") throw new Error("unexpected_response");
  assert.equal(metadata.entries.length, 1);
  assert.equal(f.state.preflights, 0);
  await f.activate(0);
  const extensions = f.store.extensionStore();
  const current = await extensions.loadExtensionActivation({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    pluginId: f.identity().pluginId,
  });
  assert.ok(current);
  await extensions.saveExtensionActivation({
    activation: {
      ...current,
      state: "disabled",
      target: null,
      revision: current.revision + 1,
    },
    expectedRevision: current.revision,
    receipt: {
      actorId: actor.actorId,
      idempotencyKey: "peer-disable-business",
      requestDigest: digester.sha256("peer-disable-business"),
    },
  });
  const withdrawn = await f.invoke(f.common("catalog"));
  if (withdrawn.operation !== "catalog") throw new Error("unexpected_response");
  assert.equal(withdrawn.entries.length, 1);
});

test("private routing, bounded fatal UTF-8 parsing and exact response echoes precede the service", async (t) => {
  let calls = 0;
  const scope = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "test-profile",
  };
  const request = {
    protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
    requestId: "request-1",
    operation: "catalog",
    actor,
    scope,
  };
  const server = await startInstalledPluginPeerServer({
    port: 0,
    token,
    service: {
      async handle(input) {
        calls++;
        const parsed = input as InstalledPluginPeerRequest;
        return {
          protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
          requestId: "wrong-echo",
          operation: "catalog",
          actor: parsed.actor,
          scope: parsed.scope,
          entries: [],
        };
      },
    },
  });
  t.after(() => server.close());
  assert.equal(
    (await fetch(server.origin + "/private/v0/extensions")).status,
    404,
  );
  assert.equal(
    (await fetch(server.origin + INSTALLED_PLUGIN_PEER_PRIVATE_PATH)).status,
    404,
  );
  assert.equal(
    (
      await post(server.origin, request, {
        headers: {
          "authorization": "Bearer wrong",
          "content-type": "application/json",
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (await post(server.origin, { ...request, syntheticRun: {} })).status,
    400,
  );
  assert.equal(
    (
      await post(server.origin, request, {
        body: Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]),
      })
    ).status,
    400,
  );
  assert.equal(
    (await post(server.origin, request, { body: "x".repeat(512 * 1024 + 1) }))
      .status,
    400,
  );
  assert.equal(calls, 0);
  assert.equal((await post(server.origin, request)).status, 503);
  assert.equal(calls, 1);
});

test(
  "deadline/disconnection cannot free a live physical slot; close joins that exact operation",
  { timeout: 10_000 },
  async (t) => {
    const entered = gate(),
      completion = gate();
    const scope = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: "test-profile",
    };
    const request = {
      protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
      requestId: "request-1",
      operation: "catalog",
      actor,
      scope,
    };
    const server = await startInstalledPluginPeerServer({
      port: 0,
      token,
      deadlineMs: 1000,
      concurrencyLimit: 1,
      service: {
        async handle(input) {
          entered.resolve();
          await completion.promise;
          const parsed = input as InstalledPluginPeerRequest;
          return {
            protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
            requestId: parsed.requestId,
            operation: "catalog",
            actor: parsed.actor,
            scope: parsed.scope,
            entries: [],
          };
        },
      },
    });
    t.after(() => {
      completion.resolve();
      return server.close();
    });
    const pending = post(server.origin, request);
    await entered.promise;
    assert.equal((await pending).status, 503);
    assert.equal((await post(server.origin, request)).status, 429);
    let finished = false;
    const closing = server.close();
    assert.equal(server.close(), closing);
    void closing.then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    completion.resolve();
    await closing;
    assert.equal(finished, true);
  },
);

test(
  "ordered shutdown physically joins borrowed IO before the actual parent Store closes",
  { timeout: 10_000 },
  async (t) => {
    const f = await peerFixture(t);
    const entered = gate(),
      physical = gate();
    f.state.beforePreflight = async () => {
      entered.resolve();
      await physical.promise;
    };
    t.after(() => physical.resolve());
    const pending = post(f.peer.origin, f.request("readiness")).catch(
      () => null,
    );
    await entered.promise;
    const lifetime = new RuntimeCompositionLifetime();
    ownInstalledPluginPeerStop({
      lifetime,
      runtimeResolver: f.resolver,
      queryHost: null,
      peer: f.peer,
    });
    lifetime.own(f.readiness, { phase: "resources" });
    let storeClosed = false;
    lifetime.own(
      {
        async close() {
          await f.closeStore();
          storeClosed = true;
        },
      },
      { phase: "storage" },
    );
    const closing = lifetime.close();
    assert.equal(lifetime.close(), closing);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(storeClosed, false);
    assert.ok(
      await f.store.loadActiveAgentVersionRelease({ tenantId: actor.tenantId }),
    );
    physical.resolve();
    await pending;
    await closing;
    assert.equal(storeClosed, true);
    assert.equal(
      await f.resolver.acquire({
        tenantId: actor.tenantId,
        agentVersionId: f.entries[0]!.target.agentVersionId,
      }),
      null,
    );
  },
);
