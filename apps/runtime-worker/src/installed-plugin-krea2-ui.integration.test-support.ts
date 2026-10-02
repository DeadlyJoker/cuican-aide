import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  ExtensionReadApplicationService,
  type PluginUiJsonValue,
} from "@crewon/application";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { loadInstalledPluginBusinessRegistration } from "./plugins/installed-plugin-business-registration.ts";
import {
  actor,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { kreaExecutionFixture } from "./installed-plugin-krea2.integration.test-support.ts";
import { businessUiFixture } from "./installed-plugin-ui-business-execution.integration.test-support.ts";

export function kreaUiReceipt(input: PluginUiJsonValue) {
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  const value = input as Readonly<Record<string, PluginUiJsonValue>>;
  assert.ok(
    value.disposition === "committed" || value.disposition === "replayed",
  );
  assert.equal(typeof value.runId, "string");
  assert.equal(typeof value.threadId, "string");
  assert.equal(typeof value.threadRevision, "number");
  return value as Readonly<{
    disposition: "committed" | "replayed";
    runId: string;
    threadId: string;
    threadRevision: number;
  }>;
}

/** Actual installed UI loader and HTTP action service share the same paid Run/Worker installation. */
export async function kreaUiFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await kreaExecutionFixture(t, backend, { queryTasks: true });
  assert.ok(f.queryHost);
  let ui = await businessUiFixture(t, f);
  const registration = f.entry.registration;
  const reads = new ExtensionReadApplicationService({
    runs: f.store,
    agentVersions: f.store,
    extensions: f.extensions,
    operations: f.operations,
    catalog: { list: () => [registration], resolve: () => registration },
    host: f.host,
    authorization: {
      authorize: async (input) => {
        assert.deepEqual(input.actor, actor);
        assert.equal(input.resource.tenantId, actor.tenantId);
        return { outcome: "allow" };
      },
    },
    digester,
  });
  return {
    ...f,
    get ui() {
      return ui;
    },
    reads,
    async upgradeUi(data: PluginUiJsonValue) {
      const directory = process.env.CREWON_TEST_KREA_PLUGIN_V2_DIR;
      assert.ok(
        directory,
        "a real independently built Krea2 v2 package is required",
      );
      await ui.close();
      const registration = await f.upgrade();
      const installed = await installLocalPluginPackage({
        directory,
        installRoot: f.pkg.input.installRoot,
        authorization: async () => ({ outcome: "allow" }),
      });
      assert.equal(
        installed.packageDigest,
        registration.identity.packageDigest,
      );
      const input = {
        ...f.pkg.input,
        expectedVersion: registration.identity.version,
        expectedPackageDigest: registration.identity.packageDigest,
        authorizeRead: async () => "allow" as const,
      };
      ui = await businessUiFixture(t, {
        ...f,
        pkg: {
          installed,
          input,
          load: () => loadInstalledPluginBusinessRegistration(input),
        },
      });
      const lease = await ui.mount(data);
      assert.equal(lease.packageDigest, registration.identity.packageDigest);
      return { registration, lease };
    },
    async generate() {
      const request = await f.prepareTask("krea-ui-generate");
      assert.equal(request.command.intent.kind, "generate");
      if (request.command.intent.kind !== "generate")
        throw new Error("fixture_generate_required");
      const lease = await ui.mount({
        threadId: request.command.threadId,
        expectedThreadRevision: request.command.expectedThreadRevision,
        idempotencyKey: request.command.idempotencyKey,
        input: request.command.intent.input,
      });
      const accepted = kreaUiReceipt(
        await ui.click('[data-action="image.generate"]'),
      );
      const worker = await f.openWorker();
      assert.deepEqual(await worker.worker.wake(), {
        kind: "completed",
        runId: accepted.runId,
      });
      const projection = await reads.getTask(actor, {
        pluginId: registration.identity.pluginId,
        runId: accepted.runId,
      });
      assert.equal(projection.operations.length, 1);
      const operation = projection.operations[0]!;
      assert.equal(operation.status, "submitted");
      assert.equal(operation.providerOperationId, operation.operationId);
      assert.equal(operation.operationId, f.submissions[0]!.prompt_id);
      assert.deepEqual(
        f.requests.map((request) => request.method),
        ["POST"],
      );
      await f.closeWorker();
      return { lease, accepted, projection, operation };
    },
    async queryProjection(sourceRunId: string, operationId: string) {
      const request = await f.prepareTask("krea-ui-query");
      return {
        threadId: request.command.threadId,
        expectedThreadRevision: request.command.expectedThreadRevision,
        queryIdempotencyKey: request.command.idempotencyKey,
        sourceRunId,
        operationId,
      };
    },
  };
}
