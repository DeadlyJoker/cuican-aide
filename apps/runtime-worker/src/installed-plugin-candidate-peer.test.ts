import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import { parseInstalledPluginPeerResponse } from "@crewon/contracts/plugins";
import { InstalledPluginExecutionReadinessOwner } from "./plugins/installed-plugin-execution-readiness.ts";
import type { InstalledPluginExecutionReadinessInput } from "./plugins/installed-plugin-execution-readiness-types.ts";
import { InstalledPluginExtensionHost } from "./plugins/installed-plugin-extension-host.ts";
import { candidateSideEffectCounts } from "./installed-plugin-candidate.test-support.ts";
import {
  actor,
  digester,
  gate,
  peerFixture,
  post,
} from "./installed-plugin-peer.test-support.ts";

type Fixture = Awaited<ReturnType<typeof peerFixture>>;
async function candidateRequest(f: Fixture) {
  const selection = await f.store
    .pluginInstallationStore()
    .loadSelection({ scope: f.scope, pluginId: f.identity().pluginId });
  assert.ok(selection);
  return {
    ...f.common("prepareCandidate"),
    identity: f.identity(),
    configuration: f.entries[0]!.configuration,
    expectedTarget: f.entries[0]!.target,
    expectedSelectionRevision: selection.revision,
  };
}
async function replaceConfiguration(f: Fixture) {
  const configurations = f.store.extensionStore();
  const entry = f.entries[0]!;
  const latest = await configurations.loadLatestExtensionConfiguration(
    entry.configuration,
  );
  assert.ok(latest);
  const configuration = createExtensionConfiguration(
    { ...latest, revision: latest.revision + 1 },
    digester,
  );
  await configurations.saveExtensionConfiguration({
    configuration,
    expectedRevision: latest.revision,
    receipt: {
      actorId: actor.actorId,
      idempotencyKey: `candidate-peer-cfg-${configuration.revision}`,
      requestDigest: digester.sha256(
        `candidate-peer-cfg-${configuration.revision}`,
      ),
    },
  });
  return configuration;
}

test("actual Krea disabled candidate prepares its real Node and same-parent IO owner while ordinary catalog and readiness stay disabled", async (t) => {
  const calls: InstalledPluginExecutionReadinessInput[] = [];
  const ready = InstalledPluginExecutionReadinessOwner.prototype.assertReady;
  t.mock.method(
    InstalledPluginExecutionReadinessOwner.prototype,
    "assertReady",
    function (
      this: InstalledPluginExecutionReadinessOwner,
      input: InstalledPluginExecutionReadinessInput,
      signal: AbortSignal,
    ) {
      calls.push(structuredClone(input));
      return ready.call(this, input, signal);
    },
  );
  const f = await peerFixture(t, "sqlite", 1, {
    activate: false,
    selectionState: "disabled",
  });
  const request = await candidateRequest(f);
  assert.equal(request.expectedSelectionRevision, 1);
  const before = await f.store
    .pluginInstallationStore()
    .loadSelection({ scope: f.scope, pluginId: f.identity().pluginId });
  assert.equal(before?.state, "disabled");
  const hidden = await f.invoke(f.common("catalog"));
  if (hidden.operation !== "catalog") throw new Error("unexpected_response");
  assert.deepEqual(hidden.entries, []);
  assert.equal(f.state.preflights, 0);
  const response = await f.invoke(request);
  if (response.operation !== "prepareCandidate")
    throw new Error("unexpected_response");
  assert.deepEqual(response.result, {
    outcome: "ready",
    target: request.expectedTarget,
  });
  assert.equal(
    response.expectedSelectionRevision,
    request.expectedSelectionRevision,
  );
  assert.deepEqual(response.identity, request.identity);
  assert.equal(
    response.configurationDigest,
    request.configuration.contentDigest,
  );
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.deepEqual(call.metadata, {
      identity: f.entries[0]!.packageIdentity,
      scope: f.scope,
      configuration: request.configuration,
      target: request.expectedTarget,
      purpose: "submit",
    });
    assert.ok(call.requiredServices.includes("externalOperations"));
    assert.ok(call.requiredServices.includes("jsonHttp"));
  }
  const preflights = f.state.preflights;
  for (const operation of ["validateConfiguration", "readiness"] as const)
    assert.notEqual(
      (await post(f.peer.origin, f.request(operation))).status,
      200,
    );
  assert.equal(f.state.preflights, preflights);
  const afterCatalog = await f.invoke(f.common("catalog"));
  if (afterCatalog.operation !== "catalog")
    throw new Error("unexpected_response");
  assert.deepEqual(afterCatalog.entries, []);
  assert.deepEqual(
    await f.store
      .pluginInstallationStore()
      .loadSelection({ scope: f.scope, pluginId: f.identity().pluginId }),
    before,
  );
  assert.ok(
    Object.values(candidateSideEffectCounts(f.databasePath)).every(
      (count) => count === 0,
    ),
  );
  assert.equal(f.state.http, 0);
  assert.equal(f.state.quotes, 0);
});

test("private candidate requires the exact current disabled revision and never treats enabled selection as a candidate", async (t) => {
  const f = await peerFixture(t, "sqlite", 1, {
    activate: false,
    selectionState: "disabled",
  });
  const request = await candidateRequest(f);
  await f.select("disabled");
  assert.notEqual((await post(f.peer.origin, request)).status, 200);
  assert.equal(f.state.preflights, 0);
  await f.select("enabled");
  const current = await candidateRequest(f);
  assert.notEqual((await post(f.peer.origin, current)).status, 200);
  assert.equal(f.state.preflights, 0);
  const ready = await f.invoke(f.request("readiness"));
  if (ready.operation !== "readiness") throw new Error("unexpected_response");
  assert.equal(ready.result.outcome, "ready");
  assert.ok(
    Object.values(candidateSideEffectCounts(f.databasePath)).every(
      (count) => count === 0,
    ),
  );
});

for (const change of [
  "configuration",
  "revision",
  "enabled",
  "packagePermission",
  "profile",
] as const)
  test(`actual candidate IO preflight rechecks ${change} and cannot return a stale ready target`, async (t) => {
    const f = await peerFixture(t, "sqlite", 1, {
      activate: false,
      selectionState: "disabled",
    });
    const request = await candidateRequest(f);
    const entered = gate(),
      release = gate();
    f.state.beforePreflight = async () => {
      entered.resolve();
      await release.promise;
    };
    const response = post(f.peer.origin, request);
    await entered.promise;
    if (change === "configuration") await replaceConfiguration(f);
    if (change === "revision") await f.select("disabled");
    if (change === "enabled") await f.select("enabled");
    if (change === "packagePermission") f.state.packageAllowed = false;
    if (change === "profile") f.state.profileAllowed = false;
    release.resolve();
    const value = await response;
    if (value.status === 200) {
      const result = parseInstalledPluginPeerResponse(await value.json());
      if (result.operation !== "prepareCandidate")
        throw new Error("unexpected_response");
      assert.equal(result.result.outcome, "unavailable");
    } else assert.ok(value.status >= 400);
    assert.equal(f.state.http, 0);
    assert.equal(f.state.quotes, 0);
    assert.ok(
      Object.values(candidateSideEffectCounts(f.databasePath)).every(
        (count) => count === 0,
      ),
    );
  });

test("candidate IO authority denial keeps actual loaded Node metadata unavailable without supplier or funds", async (t) => {
  const f = await peerFixture(t, "sqlite", 1, {
    activate: false,
    selectionState: "disabled",
  });
  f.state.ioAllowed = false;
  const response = await f.invoke(await candidateRequest(f));
  if (response.operation !== "prepareCandidate")
    throw new Error("unexpected_response");
  assert.deepEqual(response.result, {
    outcome: "unavailable",
    reasonCode: "extension_runtime_unavailable",
  });
  assert.ok(f.state.preflights > 0);
  assert.equal(f.state.http, 0);
  assert.ok(
    Object.values(candidateSideEffectCounts(f.databasePath)).every(
      (count) => count === 0,
    ),
  );
});

test("configuration CAS during the host's final real identity gate rejects ready", async (t) => {
  const f = await peerFixture(t, "sqlite", 1, {
    activate: false,
    selectionState: "disabled",
  });
  const entered = gate(),
    release = gate();
  let gated = false;
  f.state.beforeActor = async () => {
    if (f.state.preflights === 0 || gated) return;
    gated = true;
    entered.resolve();
    await release.promise;
  };
  const response = post(f.peer.origin, await candidateRequest(f));
  await entered.promise;
  await replaceConfiguration(f);
  release.resolve();
  assert.notEqual((await response).status, 200);
  assert.ok(
    Object.values(candidateSideEffectCounts(f.databasePath)).every(
      (count) => count === 0,
    ),
  );
});

test("private candidate return has no identity await after its real host's final facts and factory borrow", async (t) => {
  let finished = false,
    lateIdentityCalls = 0;
  const prepare = InstalledPluginExtensionHost.prototype.prepareCandidate;
  t.mock.method(
    InstalledPluginExtensionHost.prototype,
    "prepareCandidate",
    async function (
      this: InstalledPluginExtensionHost,
      ...args: Parameters<typeof prepare>
    ) {
      const result = await prepare.apply(this, args);
      finished = true;
      return result;
    },
  );
  const f = await peerFixture(t, "sqlite", 1, {
    activate: false,
    selectionState: "disabled",
  });
  f.state.beforeActor = async () => {
    if (!finished) return;
    lateIdentityCalls++;
    await replaceConfiguration(f);
  };
  const request = await candidateRequest(f);
  const response = await f.invoke(request);
  if (response.operation !== "prepareCandidate")
    throw new Error("unexpected_response");
  assert.equal(response.result.outcome, "ready");
  assert.equal(finished, true);
  assert.equal(lateIdentityCalls, 0);
  assert.deepEqual(
    await f.store
      .extensionStore()
      .loadLatestExtensionConfiguration(request.configuration),
    request.configuration,
  );
  assert.ok(
    Object.values(candidateSideEffectCounts(f.databasePath)).every(
      (count) => count === 0,
    ),
  );
});

test("candidate cancellation joins the real pending IO authority callback before its owner closes", async (t) => {
  const f = await peerFixture(t, "sqlite", 1, {
    activate: false,
    selectionState: "disabled",
  });
  const entered = gate(),
    release = gate();
  f.state.beforePreflight = async () => {
    entered.resolve();
    await release.promise;
  };
  const cancellation = new AbortController();
  const response = post(f.peer.origin, await candidateRequest(f), {
    signal: cancellation.signal,
  });
  const rejected = assert.rejects(response, /candidate_cancelled/);
  await entered.promise;
  cancellation.abort(new Error("candidate_cancelled"));
  let closed = false;
  const close = Promise.all([f.peer.close(), f.readiness.close()]).then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([close, rejected]);
  assert.equal(f.state.http, 0);
  assert.ok(
    Object.values(candidateSideEffectCounts(f.databasePath)).every(
      (count) => count === 0,
    ),
  );
});
