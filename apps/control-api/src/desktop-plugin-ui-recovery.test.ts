import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  ApplicationError,
  ProjectConceptSelectionApplicationService,
  createPluginUiIntentPayloadVerifier,
} from "@crewon/application";
import { parseSelectConceptImageResponse } from "@crewon/contracts/plugins";
import { extensionCanonicalJson } from "@crewon/domain";
import { SqlitePluginUiIntentJournalStore } from "../../../packages/store/src/sqlite-plugin-ui-intent-journal-store.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import {
  assertDesktopPluginUiRecoveryConfiguration,
  prepareDesktopPluginUiRecovery,
} from "./desktop-plugin-ui-recovery.ts";
import { createDesktopPluginRuntime } from "./desktop-plugin-runtime.ts";
import { DesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import type { PluginUiRecoveryConfiguration } from "./plugin-ui-recovery-composition.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import {
  nativeHistorySelectAction,
  nativeProjectHistoryFixture,
} from "./desktop-project-history-plugin-runtime.test-support.ts";

type Fixture = Awaited<ReturnType<typeof nativeProjectHistoryFixture>>;
// Native request/profile owners, source bytes, selection and journal are real.
// Historical paid target, wallet and provider are named synthetic fixtures, not live funding evidence.

test("absent Native recovery never acquires or migrates its schema and exposes no recovery route", async (t) => {
  let calls = 0;
  assert.equal(
    await prepareDesktopPluginUiRecovery({
      configuration: undefined,
      publications: [],
      selectionUi: undefined,
      store: {
        pluginUiIntentJournalStore() {
          calls++;
          throw new Error("unexpected-schema");
        },
      } as never,
      requests: {} as never,
      selection: undefined,
      clock: { now: () => timestamp },
      digester: extensionStoreDigester,
      onDiagnostic() {},
    }),
    undefined,
  );
  assert.equal(calls, 0);
  const f = await nativeProjectHistoryFixture(t);
  t.mock.method(f.parent(), "pluginUiIntentJournalStore", () => {
    calls++;
    throw new Error("unexpected-schema");
  });
  const runtime = await f.open();
  assert.equal(runtime.ui.getRecovery, undefined);
  assert.equal(runtime.ui.stageRecovery, undefined);
  assert.equal(runtime.ui.recoveryAuthenticatedRequest, undefined);
  const app = routeApp(t, f);
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/plugins/ui/mounts/absent/recovery",
    headers: f.request().headers,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(calls, 0);
  await assert.rejects(f.history.count("plugin_ui_intents"), /no such table/u);
});

test("Native recovery pure preflight rejects execution actions and unmatched exact grants before registry or SQL I/O", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  const projects = await prepareCreativeProjects(f.parent(), {
    authorization: f.authorization,
    generationReads: { version: "crewon.project-generation-read.v1" },
    resultSelections: {
      version: "crewon.project-concept-selection.v1",
      verifier: f.history.verifier,
    },
    selectionUi: { publications: f.publications },
  });
  assert.ok(projects);
  let registryCalls = 0,
    sqlCalls = 0;
  t.mock.method(DesktopPluginSourceRegistry, "create", () => {
    registryCalls++;
    throw new Error("unexpected-registry");
  });
  t.mock.method(f.parent(), "pluginInstallationStore", () => {
    sqlCalls++;
    throw new Error("unexpected-SQL");
  });
  t.mock.method(f.parent(), "pluginUiIntentJournalStore", () => {
    sqlCalls++;
    throw new Error("unexpected-journal");
  });
  const original = f.recoveryConfiguration.publications[0]!;
  const cases: readonly PluginUiRecoveryConfiguration[] = [
    {
      ...f.recoveryConfiguration,
      publications: [
        {
          ...original,
          actions: ["crewon.project-generations.v1.generateConcept"],
        },
      ],
    },
    {
      ...f.recoveryConfiguration,
      publications: [
        {
          ...original,
          actions: [
            "crewon.project-generation-queries.v1.queryConceptGeneration",
          ],
        },
      ],
    },
    {
      ...f.recoveryConfiguration,
      publications: [
        { ...original, packageDigest: "sha256:" + "f".repeat(64) },
      ],
    },
    {
      ...f.recoveryConfiguration,
      publications: [
        { ...original, pluginId: "test.native-unapproved-recovery" },
      ],
    },
    {
      ...f.recoveryConfiguration,
      publications: [{ ...original, contributionId: "unapproved-module" }],
    },
  ];
  for (const configuration of cases) {
    assert.throws(
      () =>
        assertDesktopPluginUiRecoveryConfiguration({
          configuration,
          publications: f.configuration.publications,
          selectionUi: projects.selectionUi,
        }),
      /desktop_plugin_ui_recovery_configuration_invalid/u,
    );
    await assert.rejects(
      createDesktopPluginRuntime(
        { configuration: f.configuration, uiRecovery: configuration },
        {
          store: f.parent(),
          identity: f.identity,
          creativeProjects: projects,
          clock: { now: () => timestamp },
          digester: extensionStoreDigester,
        },
      ),
      /desktop_plugin_ui_recovery_configuration_invalid/u,
    );
  }
  assert.throws(
    () =>
      assertDesktopPluginUiRecoveryConfiguration({
        configuration: f.recoveryConfiguration,
        publications: f.configuration.publications,
        selectionUi: undefined,
      }),
    /desktop_plugin_ui_recovery_configuration_invalid/u,
  );
  assert.equal(registryCalls, 0);
  assert.equal(sqlCalls, 0);
});

test("Native configured recovery still rejects a structural selection owner before journal acquisition", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  const runtime = await f.open();
  let schemaCalls = 0;
  t.mock.method(f.parent(), "pluginUiIntentJournalStore", () => {
    schemaCalls++;
    throw new Error("unexpected-journal");
  });
  await assert.rejects(
    prepareDesktopPluginUiRecovery({
      configuration: f.recoveryConfiguration,
      publications: f.configuration.publications,
      selectionUi: { publications: f.publications },
      store: f.parent(),
      requests: runtime.configuration.requests,
      selection: {
        hostUiServices: () => ({ isAvailable: () => true }),
      } as never,
      clock: { now: () => timestamp },
      digester: extensionStoreDigester,
      onDiagnostic() {},
    }),
    /desktop_plugin_ui_recovery_configuration_invalid/u,
  );
  assert.equal(schemaCalls, 0);
});

test("Native real SQLite stage and cold hydrate preserve original key, input, CAS and realm without dispatch", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { selectionRecovery: true });
  await f.open();
  const lease = await f.mount();
  const request = {
    action: nativeHistorySelectAction,
    input: f.selectionInput("named-native-cold-original-cas", 1),
  } as const;
  const before = await f.effects();
  await assert.rejects(
    f.invoke({ mountRef: lease.mountRef, ...request }),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.equal(error.code, "plugin_ui_unavailable");
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "plugin_ui_intent_stage_required");
      return true;
    },
  );
  const staged = await f.stageRecovery({
    mountRef: lease.mountRef,
    ...request,
  });
  assert.equal(staged.intent.phase, "prepared");
  assert.equal(staged.intent.dispatchAttemptCount, 0);
  assert.deepEqual(staged.intent.request, request);
  const originalRecords = await records(f);
  assert.equal(originalRecords.length, 1);
  assert.equal(
    (await f.getRecovery(lease.mountRef)).intents[0]?.phase,
    "prepared",
  );
  assert.equal((await f.currentSelection()).selectionRevision, 0);
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 0);
  assert.deepEqual(await f.effects(), before);
  await f.coldReopen();
  const cold = await f.mount();
  assert.notEqual(cold.mountRef, lease.mountRef);
  const hints = await f.getRecovery(cold.mountRef);
  assert.equal(hints.intents[0]?.retryable, true);
  assert.deepEqual(hints.intents[0]?.request, request);
  assert.deepEqual(await records(f), originalRecords);
  assert.equal((await f.currentSelection()).selectionRevision, 0);
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 0);
  const accepted = parseSelectConceptImageResponse(
    (await f.invoke({ mountRef: cold.mountRef, ...request })).output,
    selectionBody(request.input),
  );
  assert.equal(accepted.disposition, "committed");
  assert.equal(accepted.selection.resultIndex, 1);
  assert.equal(accepted.selectionRevision, 1);
  const replayed = parseSelectConceptImageResponse(
    (await f.invoke({ mountRef: cold.mountRef, ...request })).output,
    selectionBody(request.input),
  );
  assert.equal(replayed.disposition, "replayed");
  assert.deepEqual(replayed.selection, accepted.selection);
  assert.equal((await records(f))[0]?.phase, "accepted");
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 1);
  assert.deepEqual(await f.effects(), before);
  await f.assertNoNodeImport();
});

test("Native unresolved selection cannot replace original input, key or CAS and does not invoke business", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { selectionRecovery: true });
  await f.open();
  const lease = await f.mount();
  const input = f.selectionInput("named-native-immutable-original");
  const request = { action: nativeHistorySelectAction, input } as const;
  await f.stageRecovery({ mountRef: lease.mountRef, ...request });
  const before = await records(f),
    effects = await f.effects();
  for (const changed of [
    { ...input, resultIndex: 1 },
    { ...input, expectedSelectionRevision: 1 },
    { ...input, idempotencyKey: "named-native-replacement-key" },
  ]) {
    await assert.rejects(
      f.stageRecovery({
        mountRef: lease.mountRef,
        action: nativeHistorySelectAction,
        input: changed,
      }),
    );
    await assert.rejects(
      f.invoke({
        mountRef: lease.mountRef,
        action: nativeHistorySelectAction,
        input: changed,
      }),
    );
  }
  assert.deepEqual(await records(f), before);
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 0);
  assert.deepEqual(await f.effects(), effects);
});

test("Native recovery GET/stage need real request identity and independent selection grant", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { selectionRecovery: true });
  const runtime = await f.open();
  const lease = await f.mount();
  const command = {
    mountRef: lease.mountRef,
    action: nativeHistorySelectAction,
    input: f.selectionInput(),
  } as const;
  await assert.rejects(
    runtime.ui.getRecovery!(f.history.actor, { mountRef: lease.mountRef }),
  );
  await assert.rejects(runtime.ui.stageRecovery!(f.history.actor, command));
  for (const request of [
    f.request({ authorization: "Bearer wrong-native-recovery-session" }),
    f.request({ origin: "https://wrong-native-recovery.example.test" }),
    f.request({ "x-csrf-token": "wrong-native-recovery-csrf" }),
    f.request({}, "192.0.2.31"),
  ]) {
    await assert.rejects(f.stageRecovery(command, { request }));
    await assert.rejects(f.getRecovery(lease.mountRef, { request }));
  }
  for (const actor of [
    {
      ...f.history.actor,
      principalId: "named-other-native-recovery-principal",
    },
    { ...f.history.actor, actorId: "named-other-native-recovery-actor" },
    { ...f.history.actor, tenantId: "named-other-native-recovery-tenant" },
    { ...f.history.actor, spaceId: "named-other-native-recovery-space" },
  ]) {
    await assert.rejects(f.stageRecovery(command, { actor }));
    await assert.rejects(f.getRecovery(lease.mountRef, { actor }));
  }
  assert.deepEqual(await records(f), []);
  assert.equal((await f.currentSelection()).selectionRevision, 0);
  await f.close();
  await assert.rejects(
    f.open("metadata"),
    /desktop_plugin_ui_recovery_configuration_invalid/u,
  );
  await assert.rejects(
    f.open("read-only"),
    /desktop_plugin_ui_recovery_configuration_invalid/u,
  );
});

test("Native source version switch preserves UNKNOWN but cannot lend the old publication to a new package", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { selectionRecovery: true });
  const runtime = await f.open();
  const old = await f.mount();
  const request = {
    action: nativeHistorySelectAction,
    input: f.selectionInput("named-native-source-pinned-original"),
  } as const;
  await f.stageRecovery({ mountRef: old.mountRef, ...request });
  const original = await records(f),
    before = await f.effects();
  const ledger = f.parent().pluginInstallationStore();
  let selected = await ledger.loadSelection({
    scope: f.scope,
    pluginId: f.v1.pluginId,
  });
  assert.ok(selected);
  await runtime.installation.select(f.history.actor, {
    pluginId: f.v2.pluginId,
    state: "enabled",
    selectedPackageDigest: f.v2.packageDigest,
    expectedSelectionRevision: selected.revision,
    idempotencyKey: "named-native-recovery-switch-v2",
  });
  const v2 = await f.mount();
  const hint = (await f.getRecovery(v2.mountRef)).intents[0];
  assert.equal(hint?.retryable, false);
  assert.equal(hint?.reasonCode, "plugin_ui_recovery_source_changed");
  assert.deepEqual(hint?.request, request);
  await assert.rejects(f.invoke({ mountRef: old.mountRef, ...request }));
  await assert.rejects(f.stageRecovery({ mountRef: v2.mountRef, ...request }));
  await assert.rejects(f.invoke({ mountRef: v2.mountRef, ...request }));
  assert.deepEqual(await records(f), original);
  selected = await ledger.loadSelection({
    scope: f.scope,
    pluginId: f.v1.pluginId,
  });
  assert.ok(selected);
  await runtime.installation.select(f.history.actor, {
    pluginId: f.v1.pluginId,
    state: "enabled",
    selectedPackageDigest: f.v1.packageDigest,
    expectedSelectionRevision: selected.revision,
    idempotencyKey: "named-native-recovery-return-v1",
  });
  const restored = await f.mount();
  assert.equal(
    (await f.getRecovery(restored.mountRef)).intents[0]?.retryable,
    true,
  );
  const result = parseSelectConceptImageResponse(
    (await f.invoke({ mountRef: restored.mountRef, ...request })).output,
    selectionBody(request.input),
  );
  assert.equal(result.selectionRevision, 1);
  const record = (await records(f))[0]!;
  assert.deepEqual(record.sourcePin, original[0]!.sourcePin);
  assert.equal(record.requestJson, extensionCanonicalJson(request));
  assert.deepEqual(await f.effects(), before);
});

test("Native actual mandatory recovery and history services allow selection; recovery never advertises execution or provider query", async (t) => {
  for (const requiredExecution of [false, true])
    await t.test(String(requiredExecution), async (t) => {
      const f = await nativeProjectHistoryFixture(t, {
        selectionRecovery: true,
        requiredRecovery: true,
        requiredHistory: true,
        requiredExecution,
      });
      const runtime = await f.open();
      const before = await f
        .parent()
        .pluginInstallationStore()
        .loadSelection({ scope: f.scope, pluginId: f.v1.pluginId });
      assert.ok(before);
      const enable = () =>
        runtime.installation.select(f.history.actor, {
          pluginId: f.v1.pluginId,
          state: "enabled",
          selectedPackageDigest: f.v1.packageDigest,
          expectedSelectionRevision: before.revision,
          idempotencyKey: "named-native-recovery-real-service-enable",
        });
      if (requiredExecution) {
        await assert.rejects(enable(), /plugin_ui_only_services_unsupported/u);
        assert.deepEqual(
          await f
            .parent()
            .pluginInstallationStore()
            .loadSelection({ scope: f.scope, pluginId: f.v1.pluginId }),
          before,
        );
      } else {
        assert.equal((await enable()).projection.outcome, "applied");
        const lease = await f.mount();
        assert.deepEqual((await f.getRecovery(lease.mountRef)).intents, []);
        await f.coldReopen();
        const cold = await f.mount();
        assert.deepEqual((await f.getRecovery(cold.mountRef)).intents, []);
      }
      assert.equal(
        await f.history.count("creative_concept_selection_receipts"),
        0,
      );
      await f.assertNoNodeImport();
    });
});

test("Native close denies late recovery JSON while leaving its original prepared intent durable", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { selectionRecovery: true });
  const original = SqlitePluginUiIntentJournalStore.prototype.listUiIntentHints;
  let closeAfterRead = false,
    closing: Promise<void> | undefined;
  t.mock.method(
    SqlitePluginUiIntentJournalStore.prototype,
    "listUiIntentHints",
    async function (
      this: SqlitePluginUiIntentJournalStore,
      ...args: Parameters<typeof original>
    ) {
      const result = await Reflect.apply(original, this, args);
      if (closeAfterRead) {
        closeAfterRead = false;
        closing = f.close();
      }
      return result;
    },
  );
  await f.open();
  const lease = await f.mount();
  await f.stageRecovery({
    mountRef: lease.mountRef,
    action: nativeHistorySelectAction,
    input: f.selectionInput("named-native-late-read-original"),
  });
  closeAfterRead = true;
  await assert.rejects(f.getRecovery(lease.mountRef));
  assert.ok(closing);
  await closing;
  assert.equal((await records(f))[0]?.phase, "prepared");
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 0);
});

test("Native close after real stage COMMIT denies its late ACK without dispatching or replacing the prepared request", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { selectionRecovery: true });
  const original = SqlitePluginUiIntentJournalStore.prototype.stageUiIntent;
  let closeAfterStage = true,
    closing: Promise<void> | undefined;
  t.mock.method(
    SqlitePluginUiIntentJournalStore.prototype,
    "stageUiIntent",
    async function (
      this: SqlitePluginUiIntentJournalStore,
      ...args: Parameters<typeof original>
    ) {
      const result = await Reflect.apply(original, this, args);
      if (closeAfterStage) {
        closeAfterStage = false;
        closing = f.close();
      }
      return result;
    },
  );
  await f.open();
  const lease = await f.mount();
  const request = {
    action: nativeHistorySelectAction,
    input: f.selectionInput("named-native-stage-ack-lost-original"),
  } as const;
  const before = await f.effects();
  await assert.rejects(
    f.stageRecovery({ mountRef: lease.mountRef, ...request }),
  );
  assert.ok(closing);
  await closing;
  const originalRecords = await records(f);
  assert.equal(originalRecords[0]?.phase, "prepared");
  assert.equal(originalRecords[0]?.dispatchAttemptCount, 0);
  assert.equal(
    originalRecords[0]?.requestJson,
    extensionCanonicalJson(request),
  );
  await f.coldReopen();
  const cold = await f.mount();
  assert.deepEqual(
    (await f.getRecovery(cold.mountRef)).intents[0]?.request,
    request,
  );
  assert.deepEqual(await records(f), originalRecords);
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 0);
  assert.deepEqual(await f.effects(), before);
});

test("Native close waits for physical selection and journal confirmation and preserves actual opaque COMMIT", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { selectionRecovery: true });
  const original =
    ProjectConceptSelectionApplicationService.prototype.selectConceptImage;
  let reached!: () => void, release!: () => void;
  const committed = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(
    ProjectConceptSelectionApplicationService.prototype,
    "selectConceptImage",
    async function (
      this: ProjectConceptSelectionApplicationService,
      ...args: Parameters<typeof original>
    ) {
      const result = await Reflect.apply(original, this, args);
      reached();
      await gate;
      return result;
    },
  );
  const runtime = await f.open();
  const lease = await f.mount();
  const request = {
    action: nativeHistorySelectAction,
    input: f.selectionInput("named-native-physical-commit-original"),
  } as const;
  await f.stageRecovery({ mountRef: lease.mountRef, ...request });
  const before = await f.effects();
  const pending = f.invoke({ mountRef: lease.mountRef, ...request });
  await Promise.race([
    committed,
    pending.then(() => {
      throw new Error("selection must reach the physical gate");
    }),
  ]);
  let closed = false;
  const closing = f.close().then(() => {
    closed = true;
  });
  try {
    await Promise.resolve();
    assert.equal(closed, false);
    await assert.rejects(async () =>
      runtime.ui.getRecovery!(f.history.actor, { mountRef: lease.mountRef }),
    );
  } finally {
    release();
  }
  const accepted = parseSelectConceptImageResponse(
    (await pending).output,
    selectionBody(request.input),
  );
  await closing;
  assert.equal(accepted.disposition, "committed");
  assert.equal(accepted.selectionRevision, 1);
  assert.equal((await records(f))[0]?.phase, "accepted");
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 1);
  assert.deepEqual(await f.effects(), before);
});

test("Native failed journal confirmation remains UNKNOWN and only explicit original retry reconciles real committed receipt", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { selectionRecovery: true });
  const original =
    SqlitePluginUiIntentJournalStore.prototype.confirmUiIntentAccepted;
  let fail = true,
    diagnostics = 0;
  t.mock.method(process, "emitWarning", (message: string | Error) => {
    if (message === "plugin_ui_recovery_persistence_failed") diagnostics++;
  });
  t.mock.method(
    SqlitePluginUiIntentJournalStore.prototype,
    "confirmUiIntentAccepted",
    function (
      this: SqlitePluginUiIntentJournalStore,
      ...args: Parameters<typeof original>
    ) {
      if (fail)
        return Promise.reject(
          new Error("named-native-journal-confirmation-loss"),
        );
      return Reflect.apply(original, this, args);
    },
  );
  await f.open();
  const lease = await f.mount();
  const request = {
    action: nativeHistorySelectAction,
    input: f.selectionInput("named-native-confirm-lost-original"),
  } as const;
  await f.stageRecovery({ mountRef: lease.mountRef, ...request });
  const before = await f.effects();
  const accepted = parseSelectConceptImageResponse(
    (await f.invoke({ mountRef: lease.mountRef, ...request })).output,
    selectionBody(request.input),
  );
  assert.equal(accepted.disposition, "committed");
  assert.equal(diagnostics, 1);
  assert.equal((await records(f))[0]?.phase, "dispatched");
  const unknown = await records(f);
  fail = false;
  await f.coldReopen();
  const cold = await f.mount();
  const hints = await f.getRecovery(cold.mountRef);
  assert.equal(hints.intents[0]?.phase, "dispatched");
  assert.equal(hints.intents[0]?.receipt, null);
  assert.deepEqual(hints.intents[0]?.request, request);
  assert.deepEqual(await records(f), unknown);
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 1);
  const replayed = parseSelectConceptImageResponse(
    (await f.invoke({ mountRef: cold.mountRef, ...request })).output,
    selectionBody(request.input),
  );
  assert.equal(replayed.disposition, "replayed");
  assert.deepEqual(replayed.selection, accepted.selection);
  assert.equal((await records(f))[0]?.phase, "accepted");
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 1);
  assert.deepEqual(await f.effects(), before);
});

test("Native original HTTP recovery GET/stage and action routes use real identity, stage and opaque selection result", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { selectionRecovery: true });
  await f.open();
  const lease = await f.mount(),
    app = routeApp(t, f);
  const url = `/api/v1/plugins/ui/mounts/${lease.mountRef}/recovery`;
  const headers = f.request().headers;
  const request = {
    action: nativeHistorySelectAction,
    input: f.selectionInput("named-native-http-recovery-original", 1),
  } as const;
  const before = await f.effects();
  const denied = await app.inject({
    method: "POST",
    url,
    headers: { ...headers, "x-csrf-token": "wrong-native-stage-csrf" },
    payload: request,
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.deepEqual(await records(f), []);
  const staged = await app.inject({
    method: "POST",
    url,
    headers,
    payload: request,
  });
  assert.equal(staged.statusCode, 200, staged.body);
  assert.equal(staged.json().intent.phase, "prepared");
  const hydrated = await app.inject({ method: "GET", url, headers });
  assert.equal(hydrated.statusCode, 200, hydrated.body);
  assert.deepEqual(hydrated.json().intents[0].request, request);
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 0);
  const accepted = await app.inject({
    method: "POST",
    url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
    headers,
    payload: request,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(
    parseSelectConceptImageResponse(
      accepted.json().output,
      selectionBody(request.input),
    ).selectionRevision,
    1,
  );
  assert.equal((await records(f))[0]?.phase, "accepted");
  assert.deepEqual(await f.effects(), before);
  await f.assertNoNodeImport();
});

async function records(f: Fixture) {
  const journal = f.parent().pluginUiIntentJournalStore({
    verifier: createPluginUiIntentPayloadVerifier(extensionStoreDigester),
  });
  await journal.enablePluginUiIntentJournalReads();
  assert.ok(journal.uiIntentJournalRealmId);
  return journal.listUiIntentHints({
    account: {
      controlRealmId: journal.uiIntentJournalRealmId,
      tenantId: f.history.actor.tenantId,
      spaceId: f.history.actor.spaceId,
      principalId: f.history.actor.principalId,
    },
  });
}
function selectionBody(input: ReturnType<Fixture["selectionInput"]>) {
  const { idempotencyKey: _key, ...body } = input;
  return body;
}
function routeApp(
  t: Parameters<typeof nativeProjectHistoryFixture>[0],
  f: Fixture,
) {
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, request, reply) => {
    const response = errorResponse(error, request.id);
    return reply.code(response.statusCode).send(response.body);
  });
  const runtime = f.runtime();
  registerPluginControlRoutes(app, {
    identity: f.identity,
    pluginUi: runtime.ui,
    pluginInstallation: runtime.installation,
    pluginSources: runtime.sources,
  });
  return app;
}
