import assert from "node:assert/strict";
import test from "node:test";
import { InstalledPluginExtensionHost } from "./plugins/installed-plugin-extension-host.ts";
import {
  candidateFixture,
  awaitCandidateGate,
  gate,
  scope,
} from "./installed-plugin-candidate.test-support.ts";

test("dedicated candidate permission is captured and used only for preparation; execution retains submit authority", async (t) => {
  const f = await candidateFixture(t);
  let candidateChecks = 0,
    candidateAllowed = true;
  const dependencies = {
    ...f.dependencies,
    configurations: f.configurations,
    async authorizeCandidatePackage(
      input: Parameters<
        NonNullable<typeof f.dependencies.authorizeCandidatePackage>
      >[0],
    ) {
      candidateChecks++;
      assert.deepEqual(input.scope, scope);
      assert.equal(input.expectedSelectionRevision, f.selection.revision);
      assert.equal(
        input.candidate.packageDigest,
        f.entry.registration.identity.packageDigest,
      );
      return candidateAllowed ? ("allow" as const) : ("deny" as const);
    },
  };
  const host = new InstalledPluginExtensionHost(dependencies);
  dependencies.authorizeCandidatePackage = async () =>
    assert.fail("replaced candidate callback");
  try {
    f.state.packageAllowed = false;
    assert.equal((await host.prepareCandidate(f.request)).outcome, "ready");
    assert.ok(candidateChecks > 0);
    assert.equal(f.state.packageChecks, 0);
    candidateAllowed = false;
    assert.equal(
      (await host.prepareCandidate(f.request)).outcome,
      "unavailable",
    );
    await f.select("enabled");
    const checksBeforeExecution = candidateChecks;
    assert.equal((await host.evaluate(f.request)).outcome, "unavailable");
    assert.equal(candidateChecks, checksBeforeExecution);
    assert.ok(f.state.packageChecks > 0);
    f.state.packageAllowed = true;
    assert.equal((await host.evaluate(f.request)).outcome, "ready");
    assert.equal(candidateChecks, checksBeforeExecution);
  } finally {
    await host.close();
  }
});

test("first-installed disabled candidate borrows the real Node factory without enabling, activating or executing", async (t) => {
  const f = await candidateFixture(t);
  const before = f.rows();
  assert.ok(Object.values(before).every((count) => count === 0));
  const ready = await f.host.prepareCandidate(f.request);
  assert.equal(ready.outcome, "ready");
  if (ready.outcome === "ready")
    assert.equal(ready.target.agentVersionId, f.entry.version.agentVersionId);
  assert.deepEqual(await f.events(), ["import", "setup"]);
  assert.deepEqual(
    await f.installations.loadSelection({
      scope,
      pluginId: f.entry.registration.identity.pluginId,
    }),
    f.selection,
  );
  assert.deepEqual(f.rows(), before);
  assert.equal(f.factoryState.baseCalls, 0);
  assert.ok(
    f.state.actions.every(
      (action) => action === "extension:read" || action === "agentVersion:read",
    ),
  );
  await assert.rejects(f.host.evaluate(f.request), /selection_unavailable/);
  await assert.rejects(
    f.host.validateConfiguration(f.request),
    /selection_unavailable/,
  );
  assert.deepEqual(await f.events(), ["import", "setup"]);
  assert.equal((await f.host.prepareCandidate(f.request)).outcome, "ready");
  await f.host.close();
  assert.deepEqual(await f.events(), ["import", "setup", "dispose"]);
});

test("candidate alone requires the captured saved-configuration port; ordinary calls remain compatible", async (t) => {
  const f = await candidateFixture(t);
  assert.throws(
    () => f.legacyHost.prepareCandidate(f.request),
    /configurations_unavailable/,
  );
  await assert.rejects(
    f.legacyHost.evaluate(f.request),
    /selection_unavailable/,
  );
  await f.select("enabled");
  assert.equal((await f.legacyHost.evaluate(f.request)).outcome, "ready");
  await assert.rejects(
    f.host.prepareCandidate(f.request),
    /selection_unavailable/,
  );
  assert.deepEqual(
    f.rows(),
    Object.fromEntries(Object.keys(f.rows()).map((key) => [key, 0])),
  );
});

test("candidate rejects malformed revisions, extra fields and getters before reading authority or opening Node", async (t) => {
  const f = await candidateFixture(t);
  for (const expectedSelectionRevision of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
  ])
    assert.throws(
      () =>
        f.host.prepareCandidate({
          ...f.request,
          expectedSelectionRevision,
        } as never),
      /selection_revision_invalid/,
    );
  assert.throws(
    () => f.host.prepareCandidate({ ...f.request, extra: true } as never),
    /candidate_input_invalid/,
  );
  let reads = 0;
  assert.throws(
    () =>
      f.host.prepareCandidate({
        ...f.request,
        get expectedSelectionRevision() {
          reads++;
          return 1;
        },
      }),
    /candidate_input_invalid/,
  );
  assert.throws(
    () =>
      f.host.prepareCandidate({
        ...f.request,
        registration: {
          ...f.request.registration,
          get manifest() {
            reads++;
            return f.request.registration.manifest;
          },
        },
      }),
    /candidate_input_invalid/,
  );
  assert.equal(reads, 0);
  assert.deepEqual(f.state.actions, []);
  assert.deepEqual(await f.events(), []);
});

test("latest configuration is mandatory and exact; an older saved revision never imports Node", async (t) => {
  const f = await candidateFixture(t, { saveConfiguration: false });
  await assert.rejects(
    f.host.prepareCandidate(f.request),
    /configuration_unavailable/,
  );
  await f.saveConfiguration();
  await f.saveConfiguration();
  await assert.rejects(
    f.host.prepareCandidate(f.request),
    /configuration_unavailable/,
  );
  assert.deepEqual(await f.events(), []);
  assert.ok(Object.values(f.rows()).every((count) => count === 0));
});

test("exact disabled selection revision is required even when digest and configuration are unchanged", async (t) => {
  const f = await candidateFixture(t);
  await f.select("disabled");
  await assert.rejects(
    f.host.prepareCandidate(f.request),
    /selection_unavailable/,
  );
  assert.deepEqual(await f.events(), []);
  const current = await f.installations.loadSelection({
    scope,
    pluginId: f.entry.registration.identity.pluginId,
  });
  assert.ok(current);
  assert.equal(
    (
      await f.host.prepareCandidate({
        ...f.request,
        expectedSelectionRevision: current.revision,
      })
    ).outcome,
    "ready",
  );
});

for (const unavailable of [
  "factory",
  "requiredServices",
  "packagePermission",
] as const)
  test(`disabled candidate stays unavailable without actual ${unavailable}`, async (t) => {
    const f = await candidateFixture(t, {
      registerFactory: unavailable !== "factory",
      ...(unavailable === "requiredServices"
        ? { requiredServices: ["externalOperations", "jsonHttp"] as const }
        : {}),
    });
    if (unavailable === "packagePermission") f.state.packageAllowed = false;
    assert.deepEqual(await f.host.prepareCandidate(f.request), {
      outcome: "unavailable",
      reasonCode: "extension_runtime_unavailable",
    });
    assert.equal((await f.events()).includes("create"), false);
    if (unavailable === "packagePermission")
      assert.deepEqual(await f.events(), []);
    assert.deepEqual(
      await f.installations.loadSelection({
        scope,
        pluginId: f.entry.registration.identity.pluginId,
      }),
      f.selection,
    );
    assert.ok(Object.values(f.rows()).every((count) => count === 0));
  });

for (const change of [
  "configuration",
  "selectionRevision",
  "enabled",
  "deployment",
  "principal",
  "profile",
  "packagePermission",
] as const)
  test(`actual disabled Node setup rechecks ${change} before commit and never grants ready`, async (t) => {
    const f = await candidateFixture(t);
    const entered = gate(),
      release = gate();
    f.nodeState.onSetup = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.host.prepareCandidate(f.request);
    const observed = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await awaitCandidateGate(entered, observed);
      if (change === "configuration") await f.saveConfiguration();
      if (change === "selectionRevision") await f.select("disabled");
      if (change === "enabled") await f.select("enabled");
      if (change === "deployment") await f.withdrawDeployment();
      if (change === "principal")
        f.state.actor = {
          ...f.request.actor,
          principalId: "changed-principal",
        };
      if (change === "profile") f.state.profile = null;
      if (change === "packagePermission") f.state.packageAllowed = false;
    } finally {
      release.resolve();
      await observed;
    }
    const result = await observed;
    if ("value" in result) assert.equal(result.value.outcome, "unavailable");
    else
      assert.match(
        String(result.error),
        /configuration_unavailable|selection_unavailable|authority_changed|identity_invalid|profile_invalid/,
      );
    assert.deepEqual(await f.events(), ["import", "setup", "dispose"]);
    assert.ok(Object.values(f.rows()).every((count) => count === 0));
  });

test("warm disabled factory retains no current authority after configuration replacement", async (t) => {
  const f = await candidateFixture(t);
  assert.equal((await f.host.prepareCandidate(f.request)).outcome, "ready");
  await f.saveConfiguration();
  await assert.rejects(
    f.host.prepareCandidate(f.request),
    /configuration_unavailable/,
  );
  assert.deepEqual(await f.events(), ["import", "setup"]);
});

test("revoked real SDK registration is unavailable at the final asynchronous metadata recheck", async (t) => {
  const f = await candidateFixture(t);
  f.state.onPolicy = async () => {
    if (f.state.packageChecks >= 4) f.nodeState.revokeFactory?.();
  };
  assert.equal(
    (await f.host.prepareCandidate(f.request)).outcome,
    "unavailable",
  );
  assert.deepEqual(await f.events(), ["import", "setup"]);
  assert.ok(Object.values(f.rows()).every((count) => count === 0));
});

test("caller cancellation and close join actual pending disabled setup and physical disposal", async (t) => {
  const f = await candidateFixture(t);
  const setupEntered = gate(),
    setupRelease = gate(),
    disposeEntered = gate(),
    disposeRelease = gate();
  f.nodeState.onSetup = async () => {
    setupEntered.resolve();
    await setupRelease.promise;
  };
  f.nodeState.onDispose = async () => {
    disposeEntered.resolve();
    await disposeRelease.promise;
  };
  const cancellation = new AbortController();
  const pending = f.host.prepareCandidate(f.request, {
    signal: cancellation.signal,
  });
  const observed = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let settled = false;
  let close: Promise<void> | null = null;
  try {
    await awaitCandidateGate(setupEntered, observed);
    cancellation.abort(new Error("candidate_cancelled"));
    close = f.host.close().then(() => {
      settled = true;
    });
    setupRelease.resolve();
    await awaitCandidateGate(disposeEntered, close);
    assert.equal(settled, false);
  } finally {
    setupRelease.resolve();
    disposeRelease.resolve();
    await Promise.allSettled([observed, ...(close === null ? [] : [close])]);
  }
  const result = await observed;
  assert.ok(
    "error" in result,
    "cancelled candidate cannot return a readiness value",
  );
  assert.match(String(result.error), /candidate_cancelled|closed/);
  await Promise.all([close, f.host.close()]);
  assert.deepEqual(await f.events(), ["import", "setup", "dispose"]);
  assert.ok(Object.values(f.rows()).every((count) => count === 0));
});

test("already-cancelled candidate allocates no Node or runtime resources", async (t) => {
  const f = await candidateFixture(t);
  const cancellation = new AbortController();
  cancellation.abort(new Error("candidate_cancelled"));
  await assert.rejects(
    f.host.prepareCandidate(f.request, { signal: cancellation.signal }),
    /candidate_cancelled/,
  );
  assert.deepEqual(await f.events(), []);
  assert.equal(f.factoryState.transports, 0);
});
