import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ExtensionConfigurationApplicationService,
  ExtensionReadApplicationService,
  ExtensionTaskApplicationService,
  type CommitExtensionTurnResult,
} from "@crewon/application";
import {
  parseProjectGenerationQueryUiActionRequest,
  parseProjectGenerationQueryUiActionResponse,
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationUiActionResponse,
} from "@crewon/contracts/plugins";
import {
  parseProjectGenerationLink,
  parseProjectQueryLink,
} from "@crewon/domain";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { InstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";
import { InstalledPluginProjectQueryOwner } from "./installed-plugin-project-query-owner.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { InstalledPluginTaskActionOwner } from "./installed-plugin-task-action-owner.ts";
import {
  commandInput,
  deferred,
} from "./installed-plugin-task-action-owner.test-support.ts";
import { createInstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import {
  actor,
  creditScope,
  scope,
  taskRuntimeCoreFixture,
} from "./installed-plugin-task-runtime-core.test-support.ts";

// Actual installed bytes and SQLite Application transactions; all identity, readiness,
// quote and personal funding inputs are named offline fixtures, never production authority.
const originalAcknowledgement = (accepted: CommitExtensionTurnResult) => ({
  disposition: accepted.turn.disposition,
  threadId: accepted.binding.threadId,
  threadRevision: accepted.turn.threadState.revision,
  runId: accepted.binding.runId,
  messageId: accepted.turn.messages[0]!.messageId,
  configurationRevision: accepted.binding.configurationRevision,
});

test(
  "shared core borrows issued Native requests, verifies installed bytes and commits then replays exactly one paid SQLite task",
  { timeout: 20_000 },
  async (t) => {
    const f = await taskRuntimeCoreFixture(t);
    assert.equal(f.core.requests, f.requests);
    assert.ok(f.core.owner instanceof InstalledPluginTaskActionOwner);
    assert.ok(f.core.extensionTasks instanceof ExtensionTaskApplicationService);
    assert.ok(
      f.core.extensions instanceof ExtensionConfigurationApplicationService,
    );
    assert.ok(f.core.extensionReads instanceof ExtensionReadApplicationService);
    const asset = await f.ui.readAsset(actor, {
      mountRef: f.lease.mountRef,
      path: "ui.mjs",
    });
    const file = f.source.descriptor.files.find(
      (item) => item.path === "ui.mjs",
    );
    assert.ok(file);
    assert.equal(asset.bytes.byteLength, file.byteLength);
    assert.equal(
      createHash("sha256").update(asset.bytes).digest("hex"),
      file.sha256,
    );
    assert.equal(f.nodeState.setups, 0);
    const before = await f.storage.counts();
    const output = await f.invoke();
    const accepted = f.state.accepted[0]!;
    assert.deepEqual(output, originalAcknowledgement(accepted));
    const admission = await f.storage.first.store.loadPluginTaskAdmission(
      accepted.binding,
    );
    assert.ok(admission);
    assert.equal(admission.packageDigest, f.executionPackage.packageDigest);
    assert.equal(admission.profileId, f.storage.profile.profileId);
    assert.equal(admission.principalId, actor.principalId);
    const after = await f.storage.counts();
    for (const table of Object.keys(before))
      assert.equal(after[table], before[table]! + 1, table);
    const wallet = await f.storage.credits.getAccount(creditScope);
    assert.equal(wallet?.availableCredits, "70");
    assert.equal(wallet?.reservedCredits, "30");
    assert.equal(f.state.quoteCalls, 1);
    assert.equal(f.nodeState.setups, 1);
    assert.equal(f.nodeState.execution, undefined);
    assert.deepEqual(await f.invoke(), {
      ...(output as object),
      disposition: "replayed",
    });
    assert.deepEqual(await f.storage.counts(), after);
    assert.deepEqual(await f.storage.credits.getAccount(creditScope), wallet);
    assert.equal(f.state.quoteCalls, 1);
    assert.equal(f.state.accepted[1]!.binding.runId, accepted.binding.runId);
  },
);

test(
  "shared core enables its actual generation adapter and independently approved source UI through the original paid generation owner",
  { timeout: 20_000 },
  async (t) => {
    const f = await taskRuntimeCoreFixture(t, { mode: "generation" });
    assert.ok("reference" in f.storage && !("generation" in f.storage));
    assert.ok(
      f.core.projectGenerations instanceof
        InstalledPluginProjectGenerationOwner,
    );
    assert.equal(f.source.descriptor.entrypoints.node, null);
    assert.notEqual(f.source.packageDigest, f.executionPackage.packageDigest);
    const before = await f.storage.counts();
    const request = parseProjectGenerationUiActionRequest(f.command);
    const output = parseProjectGenerationUiActionResponse(
      request,
      await f.invoke(),
    );
    const accepted = f.state.accepted[0]!;
    assert.deepEqual(output, originalAcknowledgement(accepted));
    const admission = await f.storage.first.store.loadPluginTaskAdmission(
      accepted.binding,
    );
    assert.ok(admission);
    assert.equal(admission.packageDigest, f.executionPackage.packageDigest);
    assert.equal(admission.profileId, f.storage.profile.profileId);
    assert.equal(admission.principalId, actor.principalId);
    const link = parseProjectGenerationLink(
      await f.storage.first.store.loadProjectGenerationLink(accepted.binding),
      extensionStoreDigester,
    );
    assert.deepEqual(link.reference, f.storage.reference);
    assert.deepEqual(f.creativeProjects?.pluginGenerations?.publications, [
      f.storage.publication,
    ]);
    assert.equal(link.ownerPrincipalId, actor.principalId);
    const after = await f.storage.counts();
    for (const table of Object.keys(before))
      assert.equal(after[table], before[table]! + 1, table);
    assert.equal(
      (await f.storage.credits.getAccount(creditScope))?.reservedCredits,
      "30",
    );
    assert.equal(f.state.quoteCalls, 1);
    assert.equal(f.nodeState.setups, 1);
    assert.equal(f.nodeState.execution, undefined);
    assert.deepEqual(
      parseProjectGenerationUiActionResponse(request, await f.invoke()),
      {
        ...output,
        disposition: "replayed",
      },
    );
    assert.deepEqual(await f.storage.counts(), after);
    assert.equal(f.state.quoteCalls, 1);
  },
);

test(
  "shared core queries the original paid SQLite A through independently approved current installed B without another quote or hold",
  { timeout: 20_000 },
  async (t) => {
    const f = await taskRuntimeCoreFixture(t, { mode: "query" });
    assert.ok("generation" in f.storage);
    assert.ok(
      f.core.projectQueries instanceof InstalledPluginProjectQueryOwner,
    );
    assert.equal(f.core.projectGenerations, undefined);
    assert.ok(f.core.projectGenerationReads);
    assert.notEqual(
      f.storage.oldPin.packageDigest,
      f.executionPackage.packageDigest,
    );
    const before = await f.effects();
    const request = parseProjectGenerationQueryUiActionRequest(f.command);
    const output = parseProjectGenerationQueryUiActionResponse(
      request,
      await f.invoke(),
    );
    const accepted = f.state.accepted[0]!;
    assert.deepEqual(output, originalAcknowledgement(accepted));
    const admission = await f.storage.extensions.loadPluginQueryTaskAdmission(
      accepted.binding,
    );
    assert.ok(admission);
    assert.equal(admission.packageDigest, f.executionPackage.packageDigest);
    assert.equal(admission.version, "0.2.0");
    assert.equal(
      admission.source.packageDigest,
      f.storage.oldPin.packageDigest,
    );
    assert.equal(admission.source.version, "0.1.0");
    assert.equal(admission.profileId, f.storage.profile.profileId);
    assert.equal(admission.principalId, actor.principalId);
    assert.deepEqual(
      accepted.binding.target,
      f.storage.generation.binding.target,
    );
    assert.deepEqual(accepted.binding.source, {
      runId: f.storage.generation.binding.runId,
      bindingDigest: f.storage.generation.binding.bindingDigest,
      operationId: f.storage.operationId,
    });
    const link = parseProjectQueryLink(
      await f.storage.extensions.loadProjectQueryLink(accepted.binding),
      extensionStoreDigester,
    );
    assert.deepEqual(link.publication, f.storage.publication);
    assert.equal(
      link.generationLinkDigest,
      f.storage.generationLink.contentDigest,
    );
    assert.equal(
      link.executionPin.packageDigest,
      f.executionPackage.packageDigest,
    );
    const after = await f.effects();
    const writes = new Set([
      "messages",
      "run_snapshots",
      "extension_run_bindings",
      "plugin_query_task_admissions",
      "creative_project_query_links",
    ]);
    for (const table of Object.keys(before.counts)) {
      assert.equal(
        after.counts[table],
        before.counts[table]! + (writes.has(table) ? 1 : 0),
        table,
      );
    }
    assert.deepEqual(after.wallet, before.wallet);
    assert.equal(f.state.quoteCalls, 0);
    assert.ok(f.storage.state.historicalVersions.length > 0);
    assert.ok(
      f.storage.state.historicalVersions.every(
        (version) => version === "0.1.0",
      ),
    );
    assert.deepEqual(
      parseProjectGenerationQueryUiActionResponse(request, await f.invoke()),
      {
        ...output,
        disposition: "replayed",
      },
    );
    assert.deepEqual(await f.effects(), after);
    assert.equal(f.state.quoteCalls, 0);
  },
);

test(
  "borrowed Native request fences reject token, Origin, CSRF and actor substitution before Node or pricing, and current profile withdrawal prevents COMMIT",
  { timeout: 20_000 },
  async (t) => {
    const f = await taskRuntimeCoreFixture(t);
    const before = await f.effects();
    for (const headers of [
      { authorization: "Bearer named-wrong-native-token" },
      { origin: "https://named-unapproved-origin.invalid" },
      { "x-csrf-token": "named-wrong-native-csrf" },
    ])
      await assert.rejects(f.invoke({ request: f.request(headers) }));
    await assert.rejects(
      f.invoke({
        actor: { ...actor, principalId: "named-impostor-principal" },
      }),
    );
    await assert.rejects(
      f.invoke({ actor: { ...actor, tenantId: "named-impostor-tenant" } }),
    );
    assert.equal(f.state.quoteCalls, 0);
    assert.equal(f.nodeState.setups, 0);
    assert.deepEqual(await f.effects(), before);
    const entered = deferred(),
      release = deferred();
    f.state.quoteEntered = entered.resolve;
    f.state.quoteGate = release.promise;
    const pending = f.invoke();
    void pending.catch(() => {});
    await entered.promise;
    f.state.profile = {
      ...f.storage.profile,
      profileId: "named-withdrawn-native-profile",
    };
    release.resolve();
    await assert.rejects(pending);
    assert.deepEqual(await f.effects(), before);
    assert.equal(f.state.quoteCalls, 1);
    assert.equal(f.state.accepted.length, 0);
  },
);

test(
  "a named unfunded personal pool is refused by the original SQLite credit transaction with no Run or reservation",
  { timeout: 20_000 },
  async (t) => {
    const f = await taskRuntimeCoreFixture(t);
    const before = await f.effects();
    f.state.poolId = "named-unfunded-shared-core-personal-pool";
    assert.equal(
      await f.storage.credits.getAccount({
        ...creditScope,
        poolId: f.state.poolId,
      }),
      null,
    );
    await assert.rejects(f.invoke());
    assert.equal(f.state.quoteCalls, 1);
    assert.equal(f.state.accepted.length, 0);
    assert.deepEqual(await f.effects(), before);
  },
);

test(
  "a real default metadata-only request owner can read saved configuration but cannot obtain paid execution authority",
  { timeout: 20_000 },
  async (t) => {
    const f = await taskRuntimeCoreFixture(t, { metadataOnly: true });
    const before = await f.effects();
    const prepared = await f.metadata.prepare(
      { actor, scope: f.storage.profile, request: { kind: "catalog" } },
      { signal: new AbortController().signal },
    );
    assert.deepEqual(prepared.catalog.list(), []);
    const configuration = await f.requests.run(
      { request: f.request(), actor, preparation: "configuration" },
      () =>
        f.core.extensions.getConfiguration(actor, {
          pluginId: scope.pluginId,
          revision: null,
        }),
    );
    assert.ok(configuration);
    await assert.rejects(
      f.invoke(),
      /installed_plugin_request_authority_unavailable/u,
    );
    assert.equal(f.state.peerCalls, 0);
    assert.equal(f.state.quoteCalls, 0);
    assert.equal(f.nodeState.setups, 0);
    assert.deepEqual(await f.effects(), before);
  },
);

test(
  "forged borrowed request owners and missing independent source publication are rejected before any real SQLite adapter is obtained",
  { timeout: 20_000 },
  async (t) => {
    const f = await taskRuntimeCoreFixture(t, { mode: "generation" });
    const parent = f.storage.first.parent;
    const calls = { ledger: 0, extensions: 0, operations: 0 };
    const ledger = parent.pluginInstallationStore.bind(parent);
    const extensions = parent.extensionStore.bind(parent);
    const operations = parent.externalOperationStore.bind(parent);
    t.mock.method(parent, "pluginInstallationStore", () => {
      calls.ledger++;
      return ledger();
    });
    t.mock.method(parent, "extensionStore", () => {
      calls.extensions++;
      return extensions();
    });
    t.mock.method(parent, "externalOperationStore", () => {
      calls.operations++;
      return operations();
    });
    for (const forged of [
      Object.create(
        Object.getPrototypeOf(f.requests),
      ) as InstalledPluginRequestOwner,
      { ...f.requests } as InstalledPluginRequestOwner,
    ]) {
      await assert.rejects(
        createInstalledPluginTaskRuntimeCore({
          ...f.coreInput,
          requests: forged,
        }),
        /installed_plugin_task_runtime_core_invalid/u,
      );
      assert.deepEqual(calls, { ledger: 0, extensions: 0, operations: 0 });
    }
    await assert.rejects(
      createInstalledPluginTaskRuntimeCore({
        ...f.coreInput,
        publications: [],
      }),
      /publication/u,
    );
    assert.deepEqual(calls, { ledger: 0, extensions: 0, operations: 0 });
    assert.equal(f.nodeState.setups, 0);
    assert.equal(f.state.quoteCalls, 0);
  },
);

test(
  "core close waits for the physical quote and refuses admission while preserving parent Native request and SQLite ownership",
  { timeout: 20_000 },
  async (t) => {
    const f = await taskRuntimeCoreFixture(t);
    const before = await f.effects();
    const entered = deferred(),
      release = deferred();
    f.state.quoteEntered = entered.resolve;
    f.state.quoteGate = release.promise;
    const pending = f.invoke();
    void pending.catch(() => {});
    await entered.promise;
    let closed = false;
    const closing = f.core.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    release.resolve();
    await assert.rejects(pending);
    await closing;
    assert.deepEqual(await f.effects(), before);
    assert.equal(f.state.accepted.length, 0);
    assert.deepEqual(
      await f.requests.run(
        { request: f.request(), actor, preparation: "configuration" },
        async () => ({
          actor: f.requests.currentActor(),
          profile: f.requests.currentScope(),
        }),
      ),
      { actor, profile: f.storage.profile },
    );
    assert.ok(
      await f.storage.first.store.loadLatestExtensionConfiguration(scope),
    );
    const configuration = f.core.extensions.getConfiguration(actor, {
      pluginId: scope.pluginId,
      revision: null,
    });
    assert.ok(configuration instanceof Promise);
    await assert.rejects(
      configuration,
      /installed_plugin_request_authority_unavailable/u,
    );
    const catalog = f.core.extensionReads.getCatalog(actor);
    assert.ok(catalog instanceof Promise);
    await assert.rejects(
      catalog,
      /installed_plugin_request_authority_unavailable/u,
    );
    const task = f.core.extensionTasks.createTask(actor, {
      pluginId: scope.pluginId,
      threadId: commandInput.threadId,
      expectedThreadRevision: commandInput.expectedThreadRevision,
      idempotencyKey: commandInput.idempotencyKey,
      intent: { kind: "generate", input: commandInput.input },
    });
    assert.ok(task instanceof Promise);
    await assert.rejects(
      task,
      /installed_plugin_request_authority_unavailable/u,
    );
    // Closure is checked before the new internal method can inspect a stage or create a Turn.
    await assert.rejects(
      f.core.extensionTasks.createProjectMediaInputStageTurnFromHost(
        actor,
        {
          pluginId: scope.pluginId,
          threadId: commandInput.threadId,
          expectedThreadRevision: commandInput.expectedThreadRevision,
          idempotencyKey: "closed-core-media-input",
          intent: { kind: "generate", input: commandInput.input },
        },
        null as never,
      ),
      /installed_plugin_request_authority_unavailable/u,
    );
    assert.equal(f.state.quoteCalls, 1);
  },
);

test(
  "core withdrawal joins a physical original SQLite read and rejects its late result without closing the borrowed request owner",
  { timeout: 20_000 },
  async (t) => {
    const f = await taskRuntimeCoreFixture(t);
    const entered = deferred(),
      release = deferred();
    f.state.afterConfigurationRead = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.requests.run(
      { request: f.request(), actor, preparation: "configuration" },
      () =>
        f.core.extensions.getConfiguration(actor, {
          pluginId: scope.pluginId,
          revision: null,
        }),
    );
    void pending.catch(() => {});
    await entered.promise;
    let closed = false;
    const closing = f.core.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    release.resolve();
    await assert.rejects(
      pending,
      /installed_plugin_request_authority_unavailable/u,
    );
    await closing;
    const saved = await f.requests.run(
      { request: f.request(), actor, preparation: "configuration" },
      () => f.storage.first.store.loadLatestExtensionConfiguration(scope),
    );
    assert.ok(saved);
    assert.equal(f.state.quoteCalls, 0);
    assert.equal(f.nodeState.setups, 0);
  },
);

test(
  "core close cannot discard the original opaque acknowledgement after the actual paid SQLite COMMIT and waits for physical completion",
  { timeout: 20_000 },
  async (t) => {
    const f = await taskRuntimeCoreFixture(t);
    const before = await f.effects();
    const entered = deferred(),
      release = deferred();
    f.state.afterCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.invoke();
    void pending.catch(() => {});
    await entered.promise;
    const committed = f.state.accepted[0]!;
    const durable = await f.effects();
    assert.equal(
      durable.counts.run_snapshots,
      before.counts.run_snapshots! + 1,
    );
    assert.equal(durable.wallet?.reservedCredits, "30");
    assert.ok(
      await f.storage.first.store.loadPluginTaskAdmission(committed.binding),
    );
    let closed = false;
    const closing = f.core.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    release.resolve();
    assert.deepEqual(await pending, originalAcknowledgement(committed));
    await closing;
    assert.deepEqual(await f.effects(), durable);
    assert.equal(f.state.quoteCalls, 1);
    assert.equal(f.nodeState.disposals, 1);
    assert.equal(
      await f.requests.run(
        { request: f.request(), actor, preparation: "configuration" },
        async () => f.requests.currentActor().principalId,
      ),
      actor.principalId,
    );
    assert.ok(
      await f.storage.first.parent.loadRun({
        tenantId: actor.tenantId,
        runId: committed.binding.runId,
      }),
    );
  },
);
