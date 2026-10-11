import assert from "node:assert/strict";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import { PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE } from "@crewon/plugin-host";
import {
  desktopActivationFixture,
  activationTarget,
  manifest,
  save,
} from "./desktop-installed-plugin-activation.test-support.ts";

test("Native explicit activation preflights while disabled, then keeps original selection and business activation CAS receipts", async (t) => {
  const f = await desktopActivationFixture(t);
  await f.open(true);
  const enabled = await f.enable();
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().mutation.selection.state, "enabled");
  assert.equal(enabled.json().mutation.selection.revision, 2);
  assert.equal(enabled.json().projection.outcome, "applied");
  assert.deepEqual(
    f.peerCalls.map((call) => call.operation),
    ["prepareCandidate"],
  );
  const candidate = f.peerCalls[0]!;
  assert.equal(candidate.operation, "prepareCandidate");
  if (candidate.operation === "prepareCandidate") {
    assert.equal(candidate.expectedSelectionRevision, 1);
    assert.deepEqual(candidate.identity, f.identity);
    assert.deepEqual(candidate.configuration, f.configuration);
  }
  const again = await f.enable();
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().mutation.disposition, "replayed");
  assert.equal(again.json().projection.outcome, "unchanged");
  assert.equal(f.peerCalls.length, 1, "receipt does not reimport or reprepare");
  const active = await f.businessActivation();
  assert.equal(active.statusCode, 200, active.body);
  assert.equal(active.json().activation.state, "enabled");
  assert.equal(active.json().activation.revision, 1);
  assert.deepEqual(
    f.peerCalls.map((call) => call.operation),
    ["prepareCandidate", "catalog", "readiness"],
  );
  const replay = await f.businessActivation();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().disposition, "replayed");
  assert.deepEqual(replay.json().activation, active.json().activation);
  assert.equal(f.peerCalls.length, 3);
  const keyConflict = await f.request(
    "PUT",
    `/api/v1/extensions/${manifest.pluginId}/activation`,
    {
      configurationRevision: 1,
      expectedRevision: 0,
      state: "disabled",
      agentVersionId: null,
    },
    "activate-business",
  );
  assert.equal(keyConflict.statusCode, 409, keyConflict.body);
  assert.equal(keyConflict.json().error.code, "extension_idempotency_conflict");
  const facts = f.facts();
  assert.equal(facts.counts.extension_activations, 1);
  for (const table of [
    "run_snapshots",
    "extension_run_bindings",
    "extension_external_operations",
  ])
    assert.equal(facts.counts[table], 0);
  for (const table of [
    "plugin_task_admissions",
    "extension_credit_admissions",
    "plugin_credit_accounts",
    "plugin_credit_entries",
    "plugin_credit_reservations",
  ])
    assert.ok(!facts.tables.includes(table));
  const task = await f.request(
    "POST",
    `/api/v1/extensions/${manifest.pluginId}/tasks`,
    {
      threadId: "activation-does-not-admit-a-task",
      expectedThreadRevision: 1,
      intent: { kind: "generate", input: save.parameters },
    },
    "cannot-create-paid-run",
  );
  assert.equal(task.statusCode, 404, task.body);
  await f.close();
  assert.deepEqual(await f.nodeEvents(), ["load", "setup", "dispose"]);
});

test("Native candidate unavailable never enables selection, writes receipt or imports Local Node", async (t) => {
  const f = await desktopActivationFixture(t);
  f.state.readiness = {
    outcome: "unavailable",
    reasonCode: "extension_runtime_unavailable",
  };
  await f.open(true);
  const result = await f.enable();
  assert.equal(result.statusCode, 409, result.body);
  assert.equal((await f.selection()).state, "disabled");
  assert.equal((await f.selection()).revision, 1);
  assert.deepEqual(await f.nodeEvents(), []);
  assert.equal(f.facts().counts.extension_activations, 0);
  assert.equal(f.facts().counts.extension_mutation_receipts, 1);
  assert.deepEqual(
    f.peerCalls.map((call) => call.operation),
    ["prepareCandidate"],
  );
});

test("Native authorized activation rejects another Agent version as a published target conflict without a readiness RPC", async (t) => {
  const f = await desktopActivationFixture(t);
  await f.open(true);
  const enabled = await f.enable();
  assert.equal(enabled.statusCode, 200, enabled.body);
  const beforePolicy = f.policyCalls.length;
  const rejected = await f.request(
    "PUT",
    `/api/v1/extensions/${manifest.pluginId}/activation`,
    {
      configurationRevision: 1,
      expectedRevision: 0,
      state: "enabled",
      agentVersionId: "another-valid-agent-version",
    },
    "wrong-published-agent-version",
  );
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(
    rejected.json().error.code,
    "extension_execution_target_mismatch",
  );
  assert.ok(f.policyCalls.length > beforePolicy);
  assert.deepEqual(
    f.peerCalls.map((call) => call.operation),
    ["prepareCandidate", "catalog"],
  );
  assert.equal((await f.selection()).state, "enabled");
  assert.equal(f.facts().counts.extension_activations, 0);
  assert.equal(f.facts().counts.plugin_installation_receipts, 2);
  const active = await f.businessActivation();
  assert.equal(active.statusCode, 200, active.body);
  assert.deepEqual(active.json().activation.target, activationTarget);
});

test("Native actual configuration CAS after peer candidate rejection still reports the proven conflict before any enabled commit", async (t) => {
  const f = await desktopActivationFixture(t);
  await f.open(true);
  f.state.candidateResponseStatus = 409;
  f.state.beforeCandidate = async () => {
    const changed = await f.request(
      "PUT",
      `/api/v1/extensions/${manifest.pluginId}/configuration`,
      {
        ...save,
        expectedRevision: 1,
        parameters: { organization: "new configuration during peer rejection" },
      },
      "changed-before-private-peer-rejection",
    );
    assert.equal(changed.statusCode, 200, changed.body);
  };
  const rejected = await f.enable();
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(
    rejected.json().error.code,
    "desktop_plugin_candidate_configuration_changed",
  );
  assert.equal((await f.selection()).state, "disabled");
  assert.equal((await f.selection()).revision, 1);
  assert.equal(f.facts().counts.plugin_installation_receipts, 1);
  assert.equal(f.facts().counts.extension_activations, 0);
  assert.deepEqual(await f.nodeEvents(), []);
});

test("Native peer failure without changed facts remains unavailable instead of manufacturing a business conflict", async (t) => {
  const f = await desktopActivationFixture(t);
  await f.open(true);
  for (const status of [409, 503]) {
    f.state.candidateResponseStatus = status;
    const rejected = await f.enable(`actual-peer-failure-${status}`);
    assert.equal(rejected.statusCode, 500, rejected.body);
    assert.equal(
      rejected.json().error.code,
      "plugin_installation_host_unavailable",
    );
    assert.equal((await f.selection()).state, "disabled");
    assert.equal((await f.selection()).revision, 1);
    assert.equal(f.facts().counts.plugin_installation_receipts, 1);
    assert.equal(f.facts().counts.extension_activations, 0);
  }
  assert.deepEqual(await f.nodeEvents(), []);
});

test("Native named activate denial and nonlegacy authority wire cannot become module or business grants", async (t) => {
  const f = await desktopActivationFixture(t);
  await f.open(true);
  for (const response of [
    { outcome: "deny", reasonCode: "actual_fixture_denied" },
    { outcome: "allow", authorityEpoch: "unrecognized-installation-epoch" },
    { outcome: "allow", run: true },
    { outcome: "unknown" },
  ]) {
    f.state.policy = response;
    const selected = await f.enable(`denied-${f.policyCalls.length}`);
    assert.equal(selected.statusCode, 403, selected.body);
    assert.equal((await f.selection()).state, "disabled");
    const activated = await f.businessActivation(
      `business-denied-${f.policyCalls.length}`,
    );
    assert.equal(activated.statusCode, 403, activated.body);
  }
  assert.deepEqual(f.peerCalls, []);
  assert.deepEqual(await f.nodeEvents(), []);
  assert.equal(f.facts().counts.extension_activations, 0);
});

test("Native mandatory execution uses the actual host registration after peer preflight without authorizing a business task", async (t) => {
  const f = await desktopActivationFixture(t, {
    mandatoryService: "crewon.execution",
  });
  await f.open(true);
  const result = await f.enable();
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().projection.outcome, "applied");
  assert.equal((await f.selection()).state, "enabled");
  assert.deepEqual(
    f.peerCalls.map((call) => call.operation),
    ["prepareCandidate"],
  );
  assert.deepEqual(await f.nodeEvents(), ["load", "setup"]);
  assert.equal(f.facts().counts.extension_activations, 0);
  assert.equal(f.facts().counts.run_snapshots, 0);
  const store = new SqliteRunStore(f.databasePath);
  try {
    const composition = await store
      .pluginInstallationStore()
      .compositionStore()
      .loadCurrent({ scope: f.bootstrap.scope });
    assert.ok(composition);
    assert.deepEqual(composition.hostServices, [
      PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE,
    ]);
    assert.deepEqual(composition.edges, [
      {
        consumerPluginId: manifest.pluginId,
        service: "crewon.execution",
        apiVersion: "1",
        provider: {
          kind: "host",
          implementationId: "crewon.execution-registry.v1",
          implementationRevision: 1,
        },
      },
    ]);
  } finally {
    await store.close();
  }
  await f.close();
  assert.deepEqual(await f.nodeEvents(), ["load", "setup", "dispose"]);
});

test("Native configuration changes during candidate preflight reject the original release before selection CAS", async (t) => {
  const f = await desktopActivationFixture(t);
  await f.open(true);
  f.state.beforeCandidate = async () => {
    const changed = await f.request(
      "PUT",
      `/api/v1/extensions/${manifest.pluginId}/configuration`,
      {
        ...save,
        expectedRevision: 1,
        parameters: { organization: "changed during actual preparation" },
      },
      "changed-during-preflight",
    );
    assert.equal(changed.statusCode, 200, changed.body);
  };
  const result = await f.enable();
  assert.equal(result.statusCode, 409, result.body);
  assert.equal((await f.selection()).state, "disabled");
  assert.equal((await f.selection()).revision, 1);
  assert.deepEqual(await f.nodeEvents(), []);
  const staleActivate = await f.businessActivation();
  assert.equal(staleActivate.statusCode, 409, staleActivate.body);
  assert.equal(f.facts().counts.extension_activations, 0);
});

test("Native missing explicit activation preserves original metadata-only permission and never contacts private peers", async (t) => {
  const f = await desktopActivationFixture(t);
  await f.open();
  const result = await f.businessActivation();
  assert.equal(result.statusCode, 403, result.body);
  assert.deepEqual(f.peerCalls, []);
  assert.deepEqual(f.policyCalls, []);
  assert.equal(f.facts().counts.extension_activations, 0);
});

test("Native configuration changes after completed preflight are rejected by the actual transaction guard before any enabled write", async (t) => {
  const f = await desktopActivationFixture(t);
  const probe = new SqliteRunStore(f.databasePath);
  const prototype = Object.getPrototypeOf(
    probe.pluginInstallationStore(),
  ) as ReturnType<SqliteRunStore["pluginInstallationStore"]>;
  const original = prototype.commitSelection;
  await probe.close();
  let changed = false;
  t.mock.method(
    prototype,
    "commitSelection",
    async function (
      this: typeof prototype,
      ...args: Parameters<typeof original>
    ) {
      if (!changed && args[0].selection.state === "enabled") {
        changed = true;
        const saveResult = await f.request(
          "PUT",
          `/api/v1/extensions/${manifest.pluginId}/configuration`,
          {
            ...save,
            expectedRevision: 1,
            parameters: {
              organization:
                "actual configuration changed immediately before owned transaction",
            },
          },
          "configuration-before-owned-commit",
        );
        assert.equal(saveResult.statusCode, 200, saveResult.body);
      }
      return original.apply(this, args);
    },
  );
  await f.open(true);
  const selected = await f.enable();
  assert.equal(selected.statusCode, 409, selected.body);
  assert.equal(changed, true);
  assert.equal((await f.selection()).state, "disabled");
  assert.equal((await f.selection()).revision, 1);
  assert.equal(f.facts().counts.extension_activations, 0);
  assert.deepEqual(
    f.peerCalls.map((call) => call.operation),
    ["prepareCandidate"],
  );
  await f.close();
  assert.deepEqual(await f.nodeEvents(), ["load", "setup", "dispose"]);
});

test("Native actual deployment row withdrawal after completed preflight is rejected by the transaction guard before enabling", async (t) => {
  const f = await desktopActivationFixture(t);
  const probe = new SqliteRunStore(f.databasePath);
  const prototype = Object.getPrototypeOf(
    probe.pluginInstallationStore(),
  ) as ReturnType<SqliteRunStore["pluginInstallationStore"]>;
  const original = prototype.commitSelection;
  await probe.close();
  let changed = false;
  t.mock.method(
    prototype,
    "commitSelection",
    async function (
      this: typeof prototype,
      ...args: Parameters<typeof original>
    ) {
      if (!changed && args[0].selection.state === "enabled") {
        changed = true;
        f.withdrawDeployment();
      }
      return original.apply(this, args);
    },
  );
  await f.open(true);
  const selected = await f.enable();
  assert.equal(selected.statusCode, 409, selected.body);
  assert.equal(changed, true);
  assert.equal((await f.selection()).state, "disabled");
  assert.equal((await f.selection()).revision, 1);
  assert.equal(f.facts().counts.extension_activations, 0);
  await f.close();
  assert.deepEqual(await f.nodeEvents(), ["load", "setup", "dispose"]);
});
