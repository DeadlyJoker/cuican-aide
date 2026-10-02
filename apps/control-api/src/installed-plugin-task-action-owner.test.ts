import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  actor,
  commandInput,
  creditScope,
  deferred,
  ownedActionFixture,
  scope,
} from "./installed-plugin-task-action-owner.test-support.ts";
import { isInstalledPluginTaskActionOwner } from "./installed-plugin-task-action-owner.ts";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  createProductionPluginUiRuntime,
  type ProductionPluginUiConfig,
} from "./production-plugin-ui-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import {
  createProductionPostgresControlApi,
  type ProductionPostgresControlApiConfig,
} from "./production-composition.ts";
import { pluginUiProductionIdentity } from "./production-plugin-ui.test-support.ts";

const authorizationFailure = (error: unknown) =>
  error instanceof ApplicationError && error.category === "authorization";

test("owned production actions lazily open the actual installed Node package and commit one independently paid v1 task", async (t) => {
  const f = await ownedActionFixture(t);
  assert.equal(f.state.setups, 0);
  assert.equal(f.state.packageReads, 0);
  const before = await f.counts();
  const output = await f.invoke();
  const accepted = f.state.accepted[0]!;
  assert.deepEqual(output, {
    disposition: "committed",
    threadId: accepted.binding.threadId,
    threadRevision: accepted.turn.threadState.revision,
    runId: accepted.binding.runId,
    messageId: accepted.turn.messages[0]!.messageId,
    configurationRevision: accepted.binding.configurationRevision,
  });
  assert.equal(f.state.setups, 1);
  assert.equal(f.state.execution, undefined);
  assert.equal(f.state.calls, 1);
  const after = await f.counts();
  for (const table of Object.keys(before))
    assert.equal(after[table], before[table]! + 1, table);
  const pin = await f.first.store.loadPluginTaskAdmission(accepted.binding);
  assert.ok(pin);
  assert.equal(pin.packageDigest, f.installed.packageDigest);
  assert.equal(pin.profileId, f.profile.profileId);
  assert.equal(pin.principalId, actor.principalId);
  assert.equal(pin.selectionRevision, f.installed.selection.revision);
  const account = await f.credits.getAccount(creditScope);
  assert.equal(account?.availableCredits, "70");
  assert.equal(account?.reservedCredits, "30");
  assert.equal(f.state.quoteCalls, 1);
  await f.owner.close();
  assert.equal(f.state.disposals, 1);
});

test("a live invocation capability cannot be replaced by a DTO or reused after its Application action ends", async (t) => {
  const f = await ownedActionFixture(t);
  await f.invoke("image.read", null);
  assert.ok(f.state.lastContext);
  await assert.rejects(
    f.owner.actions.invoke({ ...f.state.lastContext } as PluginUiActionContext),
    /plugin_ui_invocation_unavailable/u,
  );
  await assert.rejects(
    f.owner.actions.invoke(f.state.lastContext),
    /plugin_ui_invocation_unavailable/u,
  );
  assert.equal(f.state.calls, 1);
  assert.ok(isInstalledPluginTaskActionOwner(f.owner));
  assert.ok(!isInstalledPluginTaskActionOwner({ ...f.owner }));
  assert.ok(
    !isInstalledPluginTaskActionOwner(
      Object.create(Object.getPrototypeOf(f.owner)),
    ),
  );
});

for (const change of [
  "identity",
  "profile",
  "package",
  "ui",
  "selection",
] as const) {
  test(`warm owned action rechecks current ${change} before Node dispatch or task pricing`, async (t) => {
    const f = await ownedActionFixture(t);
    await f.invoke("image.read", null);
    const before = await f.counts();
    if (change === "identity")
      f.state.actor = { ...actor, principalId: "changed-principal" };
    else if (change === "profile")
      f.state.profile = { ...f.profile, profileId: "changed-profile" };
    else if (change === "package") f.state.allowPackage = false;
    else if (change === "ui") f.state.denyUi = true;
    else await f.disable();
    await assert.rejects(
      f.invoke(),
      change === "selection"
        ? /plugin_ui_selection_changed/u
        : authorizationFailure,
    );
    assert.equal(f.state.calls, 1);
    assert.equal(f.state.setups, 1);
    assert.equal(f.state.quoteCalls, 0);
    assert.deepEqual(await f.counts(), before);
  });
}

test("same-package warm Node cache does not pin the first actor or selection revision", async (t) => {
  const f = await ownedActionFixture(t);
  await f.invoke("image.read", null);
  const nextActor = {
    ...actor,
    principalId: "principal-2",
    actorId: "actor-2",
  };
  f.state.actor = nextActor;
  const secondLease = await f.open(nextActor);
  assert.deepEqual(await f.invoke("image.read", null, nextActor, secondLease), {
    value: "installed-read",
  });
  const selected = await f.ledger.loadSelection({
    scope: f.profile,
    pluginId: scope.pluginId,
  });
  assert.ok(selected);
  await f.ledger.commitSelection(
    selectionRecipe(selected, "actual-selection-revision-change", {
      actor: nextActor,
    }),
  );
  const revisedLease = await f.open(nextActor);
  assert.deepEqual(
    await f.invoke("image.read", null, nextActor, revisedLease),
    { value: "installed-read" },
  );
  assert.equal(f.state.setups, 1);
  assert.equal(f.state.calls, 3);
});

for (const change of ["profile", "package", "selection"] as const) {
  test(`actual async Node setup cannot publish after current ${change} is withdrawn`, async (t) => {
    const f = await ownedActionFixture(t);
    const entered = deferred();
    const release = deferred();
    f.state.setupEntered = entered.resolve;
    f.state.setupGate = release.promise;
    const invoking = f.invoke();
    void invoking.catch(() => {});
    await entered.promise;
    if (change === "profile")
      f.state.profile = { ...f.profile, profileId: "withdrawn-after-setup" };
    else if (change === "package") f.state.allowPackage = false;
    else await f.disable();
    release.resolve();
    await assert.rejects(invoking);
    assert.equal(f.state.setups, 1);
    assert.equal(f.state.disposals, 1);
    assert.equal(f.state.calls, 0);
    assert.equal(f.state.quoteCalls, 0);
  });
}

test("permission loss while actual pricing awaits does not leave a Turn, Run or credit hold", async (t) => {
  const f = await ownedActionFixture(t);
  const entered = deferred();
  const release = deferred();
  f.state.quoteEntered = entered.resolve;
  f.state.quoteGate = release.promise;
  const before = await f.counts();
  const invoking = f.invoke();
  void invoking.catch(() => {});
  await entered.promise;
  f.state.allowPackage = false;
  release.resolve();
  await assert.rejects(invoking, authorizationFailure);
  assert.deepEqual(await f.counts(), before);
  assert.equal(f.state.accepted.length, 0);
  assert.equal(
    (await f.credits.getAccount(creditScope))?.availableCredits,
    "100",
  );
});

test("close waits for actual in-flight Node setup and asynchronous disposal, then blocks later admission", async (t) => {
  const f = await ownedActionFixture(t);
  const entered = deferred();
  const release = deferred();
  const disposing = deferred();
  const dispose = deferred();
  f.state.setupEntered = entered.resolve;
  f.state.setupGate = release.promise;
  f.state.disposalEntered = disposing.resolve;
  f.state.disposalGate = dispose.promise;
  const invoking = f.invoke();
  void invoking.catch(() => {});
  await entered.promise;
  let closed = false;
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release.resolve();
  await disposing.promise;
  assert.equal(closed, false);
  dispose.resolve();
  await assert.rejects(invoking);
  await closing;
  assert.equal(f.state.disposals, 1);
  await assert.rejects(f.invoke(), /installed_plugin_task_action_closed/u);
  assert.equal(f.state.quoteCalls, 0);
});

test("a real acknowledged paid COMMIT still returns its original receipt after owner close", async (t) => {
  const f = await ownedActionFixture(t);
  let closing: Promise<void> | undefined;
  f.state.afterCommit = async () => {
    closing = f.owner.close();
  };
  const output = (await f.invoke()) as Record<string, unknown>;
  assert.equal(output.disposition, "committed");
  assert.equal(output.runId, f.state.accepted[0]!.binding.runId);
  await closing;
  assert.equal(f.state.disposals, 1);
  assert.equal(
    (await f.credits.getAccount(creditScope))?.reservedCredits,
    "30",
  );
  await assert.rejects(
    f.invoke("image.generate", {
      ...commandInput,
      idempotencyKey: "later-new-task",
    }),
  );
  assert.equal(f.state.accepted.length, 1);
});

test("failed actual disposer remains owned and consumes the bounded slot instead of reopening another package", async (t) => {
  const f = await ownedActionFixture(t, {
    maximumPackages: 1,
    setupFailure: true,
    cleanupFailure: true,
  });
  await assert.rejects(
    f.invoke("image.read", null),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.cause instanceof AggregateError &&
      error.cause.message === "installed_plugin_task_action_start_failed",
  );
  assert.equal(f.state.setups, 1);
  assert.equal(f.state.disposals, 1);
  await assert.rejects(
    f.invoke("image.read", null),
    /installed_plugin_task_action_cleanup_failed/u,
  );
  await f.install("0.1.1");
  const lease = await f.open();
  await assert.rejects(
    f.invoke("image.read", null, actor, lease),
    /installed_plugin_task_action_capacity_exceeded/u,
  );
  assert.equal(f.state.setups, 1);
  await assert.rejects(
    f.owner.close(),
    /installed_plugin_task_action_cleanup_failed/u,
  );
  await assert.rejects(
    f.owner.close(),
    /installed_plugin_task_action_cleanup_failed/u,
  );
  assert.equal(f.state.disposals, 1);
});

test("a setup failure with confirmed physical cleanup releases the capacity for the next actual package", async (t) => {
  const f = await ownedActionFixture(t, {
    maximumPackages: 1,
    setupFailure: true,
  });
  await assert.rejects(
    f.invoke("image.read", null),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.cause instanceof Error &&
      error.cause.message === "actual-fixture-setup-failed",
  );
  assert.equal(f.state.disposals, 1);
  f.state.setupFailure = false;
  await f.install("0.1.1");
  const lease = await f.open();
  assert.deepEqual(await f.invoke("image.read", null, actor, lease), {
    value: "installed-read",
  });
  assert.equal(f.state.setups, 2);
  await f.owner.close();
  assert.equal(f.state.disposals, 2);
});

test("owner captures authority method identities without converting decisions into cached permission", async (t) => {
  const f = await ownedActionFixture(t);
  f.dependencies.authorizePackage = async () => "deny";
  f.dependencies.profiles.resolve = async () => ({
    ...f.profile,
    profileId: "replacement-function",
  });
  await f.invoke("image.read", null);
  f.state.allowPackage = false;
  await assert.rejects(f.invoke("image.read", null), authorizationFailure);
  assert.equal(f.state.calls, 1);
});

for (const stage of ["warm", "setup"] as const) {
  test(`actual installed bytes remain pinned around package authority at ${stage}`, async (t) => {
    const f = await ownedActionFixture(t);
    let invoking: Promise<unknown> | undefined;
    let release: ReturnType<typeof deferred> | undefined;
    if (stage === "warm") await f.invoke("image.read", null);
    else {
      const entered = deferred();
      release = deferred();
      f.state.setupEntered = entered.resolve;
      f.state.setupGate = release.promise;
      invoking = f.invoke("image.read", null);
      void invoking.catch(() => {});
      await entered.promise;
    }
    const node = join(
      f.installRoot,
      "packages",
      f.installed.packageDigest.slice(7),
      "entry.mjs",
    );
    await chmod(node, 0o600);
    await writeFile(node, "throw new Error('unapproved replacement');");
    release?.resolve();
    await assert.rejects(invoking ?? f.invoke("image.read", null));
    assert.equal(f.state.calls, stage === "warm" ? 1 : 0);
    assert.equal(f.state.setups, 1);
    await f.owner.close();
    assert.equal(f.state.disposals, 1);
  });
}

function productionConfiguration(
  f: Awaited<ReturnType<typeof ownedActionFixture>>,
) {
  return parseProductionPluginUiConfiguration({
    installRoot: f.installRoot,
    profileAuthority: {
      url: "https://explicit-fixture-authority.example/profile",
      serviceToken: "p".repeat(32),
    },
    policyAuthority: {
      url: "https://explicit-fixture-authority.example/policy",
      serviceToken: "s".repeat(32),
    },
    publications: [
      {
        pluginId: scope.pluginId,
        publisherId: f.installed.descriptor.publisherId,
        packageDigest: f.installed.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    timeoutMs: 2000,
  });
}

test("production UI composition installs actions and original receipt authority from the same actual owner and physically closes it", async (t) => {
  const f = await ownedActionFixture(t);
  const runtime = createProductionPluginUiRuntime(
    { configuration: productionConfiguration(f), ownedTaskActions: f.owner },
    {
      ledger: f.ledger,
      clock: f.dependencies.clock,
      fetch: async (url) =>
        Response.json(
          String(url).endsWith("/profile")
            ? f.state.profile
            : { outcome: "allow", authorityEpoch: f.state.epoch },
        ),
    },
  );
  t.after(() => runtime.close());
  const lease = await runtime.service.openMount(actor, {
    pluginId: scope.pluginId,
    contributionId: "workbench",
    expectedPackageDigest: f.installed.packageDigest,
    expectedSelectionRevision: f.installed.selection.revision,
  });
  const output = (await runtime.service.invoke(actor, {
    mountRef: lease.mountRef,
    action: "image.generate",
    input: commandInput,
  })) as Record<string, unknown>;
  assert.equal(output.disposition, "committed");
  assert.equal(f.state.accepted.length, 1);
  const disposing = deferred();
  const release = deferred();
  f.state.disposalEntered = disposing.resolve;
  f.state.disposalGate = release.promise;
  let closed = false;
  const closing = runtime.close().then(() => {
    closed = true;
  });
  await disposing.promise;
  assert.equal(closed, false);
  await assert.rejects(
    runtime.service.catalog(actor, { afterPluginId: null, limit: 1 }),
    /plugin_ui_service_unavailable/u,
  );
  release.resolve();
  await closing;
  assert.equal(f.state.disposals, 1);
});

test("production startup rejects conflicting ports before opening PostgreSQL and still closes the transferred actual owner", async (t) => {
  const f = await ownedActionFixture(t);
  const configuration = productionConfiguration(f);
  assert.throws(
    () =>
      createProductionPluginUiRuntime(
        {
          configuration,
          ownedTaskActions: { ...f.owner },
        } as ProductionPluginUiConfig,
        { ledger: f.ledger, clock: f.dependencies.clock },
      ),
    /production_plugin_ui_action_owner_invalid/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      connectionString: "this-is-not-a-postgres-connection",
      identity: pluginUiProductionIdentity().identity,
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      artifactStore: { close() {} },
      artifactEncryptionKeyId: "fixture-key",
      pluginUi: {
        configuration,
        ownedTaskActions: f.owner,
        actions: f.owner.actions,
      },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_plugin_ui_action_owner_conflict/u,
  );
  assert.equal(f.state.setups, 0);
  await assert.rejects(
    f.invoke("image.read", null),
    /installed_plugin_task_action_closed/u,
  );
});
