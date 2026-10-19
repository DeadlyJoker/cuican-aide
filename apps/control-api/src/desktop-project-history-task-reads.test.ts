import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationError,
  type ExtensionReadApplicationService,
  ProjectGenerationReadApplicationService,
} from "@crewon/application";
import { composeDesktopProjectHistoryTaskReads } from "./desktop-project-history-task-reads.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { nativeProjectHistoryFixture } from "./desktop-project-history-plugin-runtime.test-support.ts";

// Reader composition proof: committed paid SQL history is real; the unrelated
// prepared Native task port is an explicit nonexecuting denial fixture.
test("prepared Native namespace does not capture an unprepared package's committed paid history", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  const runtime = await f.open();
  let nativeReads = 0;
  const reader = composeDesktopProjectHistoryTaskReads({
    metadata: runtime.configuration.extensionReads,
    native: {
      getTask: async () => {
        nativeReads++;
        throw new Error("named_native_reader_not_used_for_other_namespace");
      },
    },
    preparedPluginIds: ["crewon.short-drama"],
    assertCurrent: () => runtime.configuration.requests.assertCurrent(),
  });
  const binding = f.history.generation.committed.binding;
  const before = await f.effects();
  const result = await runtime.configuration.requests.run(
    {
      request: f.request(),
      actor: f.history.actor,
      preparation: "configuration",
    },
    () =>
      reader.getTask(f.history.actor, {
        pluginId: binding.pluginId,
        runId: binding.runId,
      }),
  );
  assert.equal(result.binding.bindingDigest, binding.bindingDigest);
  assert.equal(nativeReads, 0);
  const historyStore = f.parent().extensionStore();
  await historyStore.enableProjectGenerationReads();
  const generation = new ProjectGenerationReadApplicationService({
    projects: f.history.projects,
    tasks: reader,
    extensions: historyStore,
    digester: extensionStoreDigester,
  });
  const projected = await runtime.configuration.requests.run(
    {
      request: f.request(),
      actor: f.history.actor,
      preparation: "configuration",
    },
    () => generation.getConceptGeneration(f.history.actor, f.locator),
  );
  assert.equal(projected?.task.binding.bindingDigest, binding.bindingDigest);
  assert.equal(nativeReads, 0);
  assert.deepEqual(await f.effects(), before);
});

test("same-namespace old paid Runs retain the Native rejection and never fall back after denial", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  const runtime = await f.open();
  const binding = f.history.generation.committed.binding;
  let nativeReads = 0,
    metadataReads = 0;
  const original = runtime.configuration.extensionReads.getTask;
  t.mock.method(
    runtime.configuration.extensionReads,
    "getTask",
    function (
      this: ExtensionReadApplicationService,
      ...args: Parameters<typeof original>
    ) {
      metadataReads++;
      return original.apply(this, args);
    },
  );
  const reader = composeDesktopProjectHistoryTaskReads({
    metadata: runtime.configuration.extensionReads,
    native: {
      getTask: async () => {
        nativeReads++;
        throw new ApplicationError(
          "authorization",
          "named_native_old_paid_run_denied",
        );
      },
    },
    preparedPluginIds: [binding.pluginId],
    assertCurrent: () => runtime.configuration.requests.assertCurrent(),
  });
  await assert.rejects(
    runtime.configuration.requests.run(
      {
        request: f.request(),
        actor: f.history.actor,
        preparation: "configuration",
      },
      () =>
        reader.getTask(f.history.actor, {
          pluginId: binding.pluginId,
          runId: binding.runId,
        }),
    ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "named_native_old_paid_run_denied",
  );
  assert.equal(nativeReads, 1);
  assert.equal(metadataReads, 0);
});

test("cold namespace selection preserves actor, paid admission and revoked activation guards", async (t) => {
  for (const refusal of ["scope", "admission", "activation"] as const)
    await t.test(refusal, async (t) => {
      const f = await nativeProjectHistoryFixture(t);
      const runtime = await f.open();
      const binding = f.history.generation.committed.binding;
      const reader = composeDesktopProjectHistoryTaskReads({
        metadata: runtime.configuration.extensionReads,
        native: {
          getTask: async () => {
            throw new Error("named_unrelated_native_reader_not_used");
          },
        },
        preparedPluginIds: ["crewon.short-drama"],
        assertCurrent: () => runtime.configuration.requests.assertCurrent(),
      });
      const extensions = f.parent().extensionStore();
      if (refusal === "admission")
        t.mock.method(
          Object.getPrototypeOf(extensions),
          "loadPluginTaskAdmission",
          async () => null,
        );
      if (refusal === "activation") {
        const activation = await extensions.loadExtensionActivation(binding);
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
            idempotencyKey: "named_history_reader_revoke",
            requestDigest: f.history.configuration.contentDigest,
          },
        });
      }
      const actor =
        refusal === "scope"
          ? { ...f.history.actor, spaceId: "named_other_space" }
          : f.history.actor;
      await assert.rejects(
        runtime.configuration.requests.run(
          {
            request: f.request(),
            actor: f.history.actor,
            preparation: "configuration",
          },
          () =>
            reader.getTask(actor, {
              pluginId: binding.pluginId,
              runId: binding.runId,
            }),
        ),
      );
    });
});

test("metadata catalog and readiness retain the real private receiver and stable method identity", async (t) => {
  const f = await nativeProjectHistoryFixture(t);
  const runtime = await f.open();
  const metadata = runtime.configuration.extensionReads;
  const reader = composeDesktopProjectHistoryTaskReads({
    metadata,
    native: {
      getTask: async () => {
        throw new Error("named_unrelated_native_reader_not_used");
      },
    },
    preparedPluginIds: ["crewon.short-drama"],
    assertCurrent: () => runtime.configuration.requests.assertCurrent(),
  });
  const run = <T>(work: () => Promise<T>) =>
    runtime.configuration.requests.run(
      {
        request: f.request(),
        actor: f.history.actor,
        preparation: "configuration",
      },
      work,
    );
  assert.equal(reader.getCatalog, reader.getCatalog);
  assert.equal(reader.getRuntime, reader.getRuntime);
  const catalogExpected = await run(() =>
    metadata.getCatalog(f.history.actor),
  ).catch((error: unknown) => error);
  assert.ok(catalogExpected instanceof ApplicationError);
  await assert.rejects(
    run(() => reader.getCatalog(f.history.actor)),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === catalogExpected.code &&
      error.cause instanceof Error &&
      catalogExpected.cause instanceof Error &&
      error.cause.name === catalogExpected.cause.name &&
      error.cause.message === catalogExpected.cause.message,
  );
  const query = {
    pluginId: f.v1.pluginId,
    agentVersionId:
      f.history.generation.committed.binding.target.agentVersionId,
    configurationRevision: 1,
  };
  // The metadata lane cannot authorize Agent readiness. It must retain the
  // original authorization error, rather than a Proxy private-field TypeError.
  const expected = await run(() =>
    metadata.getRuntime(f.history.actor, query),
  ).catch((error: unknown) => error);
  assert.ok(expected instanceof ApplicationError);
  await assert.rejects(
    run(() => reader.getRuntime(f.history.actor, query)),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === expected.code &&
      error.category === expected.category,
  );
});
