import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  ProjectConceptSelectionApplicationService,
  ProjectGenerationReadApplicationService,
} from "@crewon/application";
import {
  parseGetConceptSelectionResponse,
  parseProjectGenerationReadUiActionResponse,
  parseSelectConceptImageResponse,
} from "@crewon/contracts/plugins";
import { installationRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import { createProjectGenerationReadPluginRuntime } from "./project-history-plugin-runtime.ts";
import {
  nativeHistoryCurrentAction,
  nativeHistoryReadAction,
  nativeHistorySelectAction,
  nativeProjectHistoryFixture,
} from "./desktop-project-history-plugin-runtime.test-support.ts";

test("Native explicit history grant reads original SQL result and selects the exact second image without new execution or holds", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  await f.open();
  const lease = await f.mount();
  const before = await f.effects();
  let transportCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    transportCalls++;
    throw new Error("named-native-history-has-no-provider-or-quote-transport");
  });
  const readRequest = {
    action: nativeHistoryReadAction,
    input: f.locator,
  } as const;
  const observed = await f.invoke({ mountRef: lease.mountRef, ...readRequest });
  const read = parseProjectGenerationReadUiActionResponse(
    readRequest,
    observed.output,
  );
  assert.ok(read.generation);
  assert.equal(
    read.generation.task.runId,
    f.history.generation.committed.binding.runId,
  );
  assert.equal(
    read.generation.task.configurationRevision,
    f.history.configuration.revision,
  );
  assert.deepEqual(
    read.generation.task.operations[0]?.images,
    f.history.generation.images.map((image, resultIndex) => ({
      filename: image.filename,
      url: image.url,
      resultIndex,
    })),
  );
  const input = f.selectionInput("named-native-select-second-image", 1);
  const selected = await f.invoke({
    mountRef: lease.mountRef,
    action: nativeHistorySelectAction,
    input,
  });
  const selection = parseSelectConceptImageResponse(
    selected.output,
    selectionBody(input),
  );
  assert.equal(selection.disposition, "committed");
  assert.equal(selection.selectionRevision, 1);
  assert.equal(
    selection.selection.operationId,
    f.history.generation.operation.operationId,
  );
  assert.equal(
    selection.selection.operationRevision,
    f.history.generation.operation.revision,
  );
  assert.equal(selection.selection.resultIndex, 1);
  assert.equal(selection.selection.url, f.history.generation.images[1]?.url);
  assert.equal((await f.currentSelection()).selectionRevision, 1);
  assert.deepEqual(await f.effects(), before);
  assert.equal(transportCalls, 0);
  await f.assertNoNodeImport();
});

test("Native cold owner and SQLite reopen preserve original generation and immutable selection replay", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  await f.open();
  const lease = await f.mount();
  const input = f.selectionInput("named-native-cold-selection-key");
  const selected = parseSelectConceptImageResponse(
    (
      await f.invoke({
        mountRef: lease.mountRef,
        action: nativeHistorySelectAction,
        input,
      })
    ).output,
    selectionBody(input),
  );
  const before = await f.effects();
  await f.coldReopen();
  const cold = await f.mount();
  assert.notEqual(cold.mountRef, lease.mountRef);
  await assert.rejects(
    f.invoke({
      mountRef: lease.mountRef,
      action: nativeHistoryReadAction,
      input: f.locator,
    }),
  );
  const replayed = parseSelectConceptImageResponse(
    (
      await f.invoke({
        mountRef: cold.mountRef,
        action: nativeHistorySelectAction,
        input,
      })
    ).output,
    selectionBody(input),
  );
  assert.equal(replayed.disposition, "replayed");
  assert.deepEqual(replayed.selection, selected.selection);
  const current = parseGetConceptSelectionResponse(
    (
      await f.invoke({
        mountRef: cold.mountRef,
        action: nativeHistoryCurrentAction,
        input: { projectId: f.locator.projectId, assetId: f.locator.assetId },
      })
    ).output,
    { projectId: f.locator.projectId, assetId: f.locator.assetId },
  );
  assert.equal(current.selectionRevision, 1);
  assert.equal(
    current.current?.operationId,
    f.history.generation.operation.operationId,
  );
  assert.deepEqual(await f.effects(), before);
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 1);
  await f.assertNoNodeImport();
});

test("Native historical business actions need the real enclosing HTTP request even with an approved source mount", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  await f.open();
  const lease = await f.mount();
  const before = await f.effects();
  await assert.rejects(
    f.runtime().ui.invoke(f.history.actor, {
      mountRef: lease.mountRef,
      action: nativeHistoryReadAction,
      input: f.locator,
    }),
  );
  await assert.rejects(
    f.runtime().ui.invoke(f.history.actor, {
      mountRef: lease.mountRef,
      action: nativeHistorySelectAction,
      input: f.selectionInput(),
    }),
  );
  assert.equal((await f.currentSelection()).selectionRevision, 0);
  const valid = await f.invoke({
    mountRef: lease.mountRef,
    action: nativeHistoryReadAction,
    input: f.locator,
  });
  assert.ok(valid.output);
  assert.deepEqual(await f.effects(), before);
});

test("Native session, Origin, CSRF, loopback and asserted actor cannot be substituted for the original request identity", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  await f.open();
  const lease = await f.mount();
  const command = {
    mountRef: lease.mountRef,
    action: nativeHistorySelectAction,
    input: f.selectionInput(),
  };
  const before = await f.effects();
  for (const request of [
    f.request({ authorization: "Bearer invalid-native-history-session" }),
    f.request({ origin: "https://unapproved-native-history.example.test" }),
    f.request({ "x-csrf-token": "invalid-native-history-csrf" }),
    f.request({}, "192.0.2.17"),
  ])
    await assert.rejects(f.invoke(command, { request }));
  for (const actor of [
    { ...f.history.actor, principalId: "named-other-native-history-principal" },
    { ...f.history.actor, actorId: "named-other-native-history-actor" },
    { ...f.history.actor, tenantId: "named-other-native-history-tenant" },
    { ...f.history.actor, spaceId: "named-other-native-history-space" },
  ])
    await assert.rejects(f.invoke(command, { actor }));
  assert.equal((await f.currentSelection()).selectionRevision, 0);
  assert.deepEqual(await f.effects(), before);
  await f.assertNoNodeImport();
});

test("Native metadata publication and a read-only publication independently deny image selection", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  await f.open("metadata");
  let lease = await f.mount();
  const before = await f.effects();
  for (const command of [
    {
      mountRef: lease.mountRef,
      action: nativeHistoryReadAction,
      input: f.locator,
    },
    {
      mountRef: lease.mountRef,
      action: nativeHistorySelectAction,
      input: f.selectionInput(),
    },
  ])
    await assert.rejects(
      f.runtime().configuration.requests.run(
        {
          request: f.request(),
          actor: f.history.actor,
          preparation: "configuration",
        },
        () => f.runtime().ui.invoke(f.history.actor, command),
      ),
    );
  await f.close();
  await f.open("read-only");
  lease = await f.mount();
  assert.ok(
    (
      await f.invoke({
        mountRef: lease.mountRef,
        action: nativeHistoryReadAction,
        input: f.locator,
      })
    ).output,
  );
  await assert.rejects(
    f.invoke({
      mountRef: lease.mountRef,
      action: nativeHistorySelectAction,
      input: f.selectionInput(),
    }),
  );
  assert.equal((await f.currentSelection()).selectionRevision, 0);
  assert.deepEqual(await f.effects(), before);
});

test("Native original admission principal, actor and physical profile remain necessary for historical task reads", async (t) => {
  for (const field of ["principalId", "actorId", "profileId"] as const) {
    await t.test(field, async (t) => {
      const f = await nativeProjectHistoryFixture(t);
      await f.open();
      const lease = await f.mount();
      const original = await f
        .parent()
        .extensionStore()
        .loadPluginTaskAdmission(f.history.generation.committed.binding);
      assert.ok(original);
      const changed = `named-foreign-native-history-${field}`;
      if (field === "profileId") {
        await f
          .parent()
          .pluginInstallationStore()
          .recordInstalledPackage(await installationForProfile(f, changed));
      }
      // Deliberately corrupt this named SQLite fixture, keeping its SQL columns and JSON consistent.
      // Production's immutable-admission trigger is restored after the counterexample is installed.
      const column = {
        principalId: "principal_id",
        actorId: "actor_id",
        profileId: "profile_id",
      }[field];
      await f.history.sql("DROP TRIGGER plugin_task_admissions_no_update");
      await f.history.sql(
        `UPDATE plugin_task_admissions SET ${column}=${sqlText(changed)}, admission_json=json_set(admission_json, ${sqlText(`$.${field}`)}, ${sqlText(changed)}) WHERE run_id=${sqlText(original.runId)}`,
      );
      await f.history.sql(
        "CREATE TRIGGER plugin_task_admissions_no_update BEFORE UPDATE ON plugin_task_admissions BEGIN SELECT RAISE(ABORT,'plugin_task_admission_immutable'); END",
      );
      const before = await f.effects();
      await assert.rejects(
        f.invoke({
          mountRef: lease.mountRef,
          action: nativeHistoryReadAction,
          input: f.locator,
        }),
      );
      await assert.rejects(
        f.invoke({
          mountRef: lease.mountRef,
          action: nativeHistorySelectAction,
          input: f.selectionInput(),
        }),
      );
      assert.equal((await f.currentSelection()).selectionRevision, 0);
      assert.deepEqual(await f.effects(), before);
    });
  }
});

test("Native version switch invalidates the old source lease without changing original target history", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  await f.open();
  const old = await f.mount();
  const before = await f.effects();
  const ledger = f.parent().pluginInstallationStore();
  const selection = await ledger.loadSelection({
    scope: f.scope,
    pluginId: f.v1.pluginId,
  });
  assert.ok(selection);
  const switched = await f.runtime().installation.select(f.history.actor, {
    pluginId: f.v2.pluginId,
    expectedSelectionRevision: selection.revision,
    state: "enabled",
    selectedPackageDigest: f.v2.packageDigest,
    idempotencyKey: "named-native-history-switch-v2",
  });
  assert.equal(
    switched.mutation.selection.selectedPackageDigest,
    f.v2.packageDigest,
  );
  assert.equal(switched.projection.outcome, "applied");
  const current = await f.mount();
  await assert.rejects(
    f.invoke({
      mountRef: old.mountRef,
      action: nativeHistoryReadAction,
      input: f.locator,
    }),
  );
  const request = {
    action: nativeHistoryReadAction,
    input: f.locator,
  } as const;
  const output = parseProjectGenerationReadUiActionResponse(
    request,
    (await f.invoke({ mountRef: current.mountRef, ...request })).output,
  );
  assert.equal(
    output.generation?.task.pluginVersion,
    f.history.configuration.pluginVersion,
  );
  assert.equal(
    output.generation?.task.configurationRevision,
    f.history.configuration.revision,
  );
  assert.deepEqual(await f.effects(), before);
  await f.assertNoNodeImport();
});

test("Native unknown target, revoked original activation and closed owner cannot grant historical business access", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  const runtime = await f.open();
  const lease = await f.mount();
  const before = await f.effects();
  await assert.rejects(
    runtime.configuration.requests.run(
      {
        request: f.request(),
        actor: f.history.actor,
        preparation: "configuration",
      },
      () =>
        runtime.configuration.extensionReads.getTask(f.history.actor, {
          pluginId: "test.native-unapproved-unknown-target",
          runId: f.history.generation.committed.binding.runId,
        }),
    ),
  );
  const extensions = f.parent().extensionStore();
  const scope = {
    tenantId: f.history.actor.tenantId,
    spaceId: f.history.actor.spaceId,
    pluginId: f.history.generation.committed.binding.pluginId,
  };
  const activation = await extensions.loadExtensionActivation(scope);
  assert.ok(activation);
  await extensions.saveExtensionActivation({
    activation: {
      ...activation,
      revision: activation.revision + 1,
      state: "revoked",
    },
    expectedRevision: activation.revision,
    receipt: {
      actorId: f.history.actor.actorId,
      idempotencyKey: "named-native-revoke-original-history",
      requestDigest: f.history.configuration.contentDigest,
    },
  });
  await assert.rejects(
    f.invoke({
      mountRef: lease.mountRef,
      action: nativeHistoryReadAction,
      input: f.locator,
    }),
  );
  await assert.rejects(
    f.invoke({
      mountRef: lease.mountRef,
      action: nativeHistorySelectAction,
      input: f.selectionInput(),
    }),
  );
  assert.equal((await f.currentSelection()).selectionRevision, 0);
  assert.deepEqual(await f.effects(), before);
  await f.close();
  await assert.rejects(async () =>
    runtime.ui.invoke(f.history.actor, {
      mountRef: lease.mountRef,
      action: nativeHistoryReadAction,
      input: f.locator,
    }),
  );
  await f.assertNoNodeImport();
});

test("Native close after the actual historical read prevents its late ordinary JSON from escaping", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  const original =
    ProjectGenerationReadApplicationService.prototype.getConceptGeneration;
  let observeClose = false;
  let closing: Promise<void> | undefined;
  t.mock.method(
    ProjectGenerationReadApplicationService.prototype,
    "getConceptGeneration",
    async function (
      this: ProjectGenerationReadApplicationService,
      ...args: Parameters<typeof original>
    ) {
      const result = await Reflect.apply(original, this, args);
      if (observeClose) {
        observeClose = false;
        closing = f.close();
      }
      return result;
    },
  );
  await f.open();
  const lease = await f.mount();
  const before = await f.effects();
  observeClose = true;
  await assert.rejects(
    f.invoke({
      mountRef: lease.mountRef,
      action: nativeHistoryReadAction,
      input: f.locator,
    }),
  );
  assert.ok(closing, "close observes the original real read result");
  await closing;
  assert.equal((await f.currentSelection()).selectionRevision, 0);
  assert.deepEqual(await f.effects(), before);
  await f.assertNoNodeImport();
});

test("Native close after actual image-selection COMMIT retains the opaque accepted result", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  const original =
    ProjectConceptSelectionApplicationService.prototype.selectConceptImage;
  let observeClose = false;
  let closing: Promise<void> | undefined;
  t.mock.method(
    ProjectConceptSelectionApplicationService.prototype,
    "selectConceptImage",
    async function (
      this: ProjectConceptSelectionApplicationService,
      ...args: Parameters<typeof original>
    ) {
      const result = await Reflect.apply(original, this, args);
      if (observeClose) {
        observeClose = false;
        closing = f.close();
      }
      return result;
    },
  );
  await f.open();
  const lease = await f.mount();
  const before = await f.effects();
  const input = f.selectionInput("named-native-committed-before-close");
  observeClose = true;
  const result = parseSelectConceptImageResponse(
    (
      await f.invoke({
        mountRef: lease.mountRef,
        action: nativeHistorySelectAction,
        input,
      })
    ).output,
    selectionBody(input),
  );
  assert.ok(closing, "close observes the original actual selection COMMIT");
  await closing;
  assert.equal(result.disposition, "committed");
  assert.equal(
    result.selection.operationId,
    f.history.generation.operation.operationId,
  );
  assert.equal(result.selectionRevision, 1);
  assert.equal((await f.currentSelection()).selectionRevision, 1);
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 1);
  assert.deepEqual(await f.effects(), before);
  await f.assertNoNodeImport();
});

test("Native history owners cannot enable actual source bytes requiring the unavailable mandatory recovery protocol", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { requiredRecovery: true });
  const runtime = await f.open();
  const ledger = f.parent().pluginInstallationStore();
  const beforeSelection = await ledger.loadSelection({
    scope: f.scope,
    pluginId: f.v1.pluginId,
  });
  assert.ok(beforeSelection);
  assert.equal(beforeSelection.state, "disabled");
  const before = await f.effects();
  await assert.rejects(
    async () =>
      runtime.installation.select(f.history.actor, {
        pluginId: f.v1.pluginId,
        expectedSelectionRevision: beforeSelection.revision,
        state: "enabled",
        selectedPackageDigest: f.v1.packageDigest,
        idempotencyKey: "named-native-required-recovery-enable-denied",
      }),
    /plugin_dependency_unavailable/u,
  );
  assert.deepEqual(
    await ledger.loadSelection({
      scope: f.scope,
      pluginId: f.v1.pluginId,
    }),
    beforeSelection,
  );
  assert.equal(await f.history.count("creative_concept_selection_receipts"), 0);
  assert.deepEqual(await f.effects(), before);
  await f.assertNoNodeImport();
});

test("Native existing HTTP plugin routes carry actual authenticated history and selection through the original response contract", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  const runtime = await f.open();
  const lease = await f.mount();
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, request, reply) => {
    const response = errorResponse(error, request.id);
    return reply.code(response.statusCode).send(response.body);
  });
  registerPluginControlRoutes(app, {
    identity: f.identity,
    pluginUi: runtime.ui,
    pluginInstallation: runtime.installation,
    pluginSources: runtime.sources,
  });
  const url = `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`;
  const headers = f.request().headers;
  const before = await f.effects();
  const query = { action: nativeHistoryReadAction, input: f.locator } as const;
  const read = await app.inject({
    method: "POST",
    url,
    headers,
    payload: query,
  });
  assert.equal(read.statusCode, 200, read.body);
  const observed = parseProjectGenerationReadUiActionResponse(
    query,
    read.json().output,
  );
  assert.equal(
    observed.generation?.task.runId,
    f.history.generation.committed.binding.runId,
  );
  const input = f.selectionInput("named-native-http-original-selection");
  const denied = await app.inject({
    method: "POST",
    url,
    headers: { ...headers, "x-csrf-token": "wrong-native-http-csrf" },
    payload: { action: nativeHistorySelectAction, input },
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal((await f.currentSelection()).selectionRevision, 0);
  const accepted = await app.inject({
    method: "POST",
    url,
    headers,
    payload: { action: nativeHistorySelectAction, input },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const selected = parseSelectConceptImageResponse(
    accepted.json().output,
    selectionBody(input),
  );
  assert.equal(selected.disposition, "committed");
  assert.equal(
    selected.selection.operationId,
    f.history.generation.operation.operationId,
  );
  assert.equal(selected.selectionRevision, 1);
  assert.deepEqual(await f.effects(), before);
  await f.assertNoNodeImport();
});

test("Shared history owner close never closes the real borrowed Native request owner or its independent installed reader", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  const runtime = await f.open();
  const extensions = f.parent().extensionStore();
  await extensions.enableProjectGenerationReads();
  const reads = new ProjectGenerationReadApplicationService({
    projects: f.history.projects,
    tasks: runtime.configuration.extensionReads,
    extensions,
    digester: extensionStoreDigester,
  });
  const shared = createProjectGenerationReadPluginRuntime({
    configuration: {
      publications: [
        {
          pluginId: f.v1.pluginId,
          packageDigest: f.v1.packageDigest,
          contributionId: "workbench",
        },
      ],
    },
    reads,
    taskReads: runtime.configuration.extensionReads,
    requests: runtime.configuration.requests,
    publications: f.configuration.publications,
  });
  await shared.close();
  let invocations = 0;
  await assert.rejects(async () =>
    shared.invokeAuthenticatedRequest(
      f.request(),
      f.history.actor,
      {
        mountRef: "closed-shared-reader",
        action: nativeHistoryReadAction,
        input: f.locator,
      },
      undefined,
      async () => {
        invocations++;
        return {};
      },
    ),
  );
  assert.equal(invocations, 0);
  const task = await runtime.configuration.requests.run(
    {
      request: f.request(),
      actor: f.history.actor,
      preparation: "configuration",
    },
    () =>
      runtime.configuration.extensionReads.getTask(f.history.actor, {
        pluginId: f.history.generation.committed.binding.pluginId,
        runId: f.history.generation.committed.binding.runId,
      }),
  );
  assert.equal(
    task.binding.runId,
    f.history.generation.committed.binding.runId,
  );
  const lease = await f.mount();
  const query = { action: nativeHistoryReadAction, input: f.locator } as const;
  const stillAvailable = parseProjectGenerationReadUiActionResponse(
    query,
    (await f.invoke({ mountRef: lease.mountRef, ...query })).output,
  );
  assert.equal(stillAvailable.generation?.task.runId, task.binding.runId);
});

test("Native mandatory history services enable only with their actual independently approved owners", async (t) => {
  const f = await nativeProjectHistoryFixture(t, { requiredHistory: true });
  let runtime = await f.open("metadata");
  const before = await f.effects();
  const selection = await f
    .parent()
    .pluginInstallationStore()
    .loadSelection({ scope: f.scope, pluginId: f.v1.pluginId });
  assert.ok(selection);
  assert.equal(selection.state, "disabled");
  const command = {
    pluginId: f.v1.pluginId,
    expectedSelectionRevision: selection.revision,
    state: "enabled" as const,
    selectedPackageDigest: f.v1.packageDigest,
    idempotencyKey: "named-native-requires-history-owners",
  };
  await assert.rejects(
    runtime.installation.select(f.history.actor, command),
    /plugin_dependency_unavailable/u,
  );
  await f.close();
  runtime = await f.open();
  const enabled = await runtime.installation.select(f.history.actor, command);
  assert.equal(enabled.mutation.selection.state, "enabled");
  assert.equal(enabled.projection.outcome, "applied");
  const lease = await f.mount();
  const query = { action: nativeHistoryReadAction, input: f.locator } as const;
  const read = parseProjectGenerationReadUiActionResponse(
    query,
    (await f.invoke({ mountRef: lease.mountRef, ...query })).output,
  );
  assert.equal(
    read.generation?.task.runId,
    f.history.generation.committed.binding.runId,
  );
  assert.deepEqual(await f.effects(), before);
  await f.assertNoNodeImport();
});

function sqlText(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

function selectionBody(
  input: ReturnType<
    Awaited<ReturnType<typeof nativeProjectHistoryFixture>>["selectionInput"]
  >,
) {
  const { idempotencyKey: _key, ...body } = input;
  return body;
}

async function installationForProfile(
  f: Awaited<ReturnType<typeof nativeProjectHistoryFixture>>,
  profileId: string,
) {
  const original = f.history.enabled.selection;
  assert.ok(original.selectedPackageDigest);
  const pkg = await f.parent().pluginInstallationStore().loadPackage({
    scope: f.scope,
    packageDigest: original.selectedPackageDigest,
  });
  assert.ok(pkg);
  return installationRecipe("named-native-foreign-history-profile", {
    scope: { ...f.scope, profileId },
    actor: f.history.actor,
    pluginId: pkg.pluginId,
    publisherId: pkg.publisherId,
    version: pkg.version,
    packageDigest: pkg.packageDigest,
  });
}
