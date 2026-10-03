import assert from "node:assert/strict";
import test from "node:test";
import { createProductionProjectGenerationReadPluginRuntime } from "./production-project-generation-read-plugin-runtime.ts";
import { captureInstalledPluginReadRequestScope } from "./installed-plugin-request-owner.ts";
import { generationReadPluginFixture } from "./production-project-generation-read-plugin-runtime.test-support.ts";
import { createProductionPluginUiRuntime } from "./production-plugin-ui-composition.ts";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { parseInstalledPluginConfigurationConfig } from "./installed-plugin-configuration-environment.ts";
import {
  configDocument,
  environment,
} from "./installed-plugin-configuration.test-support.ts";
import { projectPluginDisabledScans } from "./creative-project-plugin.integration.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 60000,
  };
  test(
    `${backend}: actual installed source read action returns null then restores original saved generation/results without new fees or execution`,
    options,
    async (t) => {
      const f = await generationReadPluginFixture(t, backend);
      const lease = await f.mount();
      const initial = await f.invoke(lease.mountRef);
      assert.equal(initial.statusCode, 200, initial.body);
      assert.deepEqual(initial.json().output, { generation: null });
      const committed = await f.commitGenerationWithResult();
      const before = await f.counts(),
        balance = await f.credits.getAccount(f.creditScope);
      const result = await f.invoke(lease.mountRef);
      assert.equal(result.statusCode, 200, result.body);
      const response = f.decode(
        f.command(lease.mountRef),
        result.json().output,
      );
      assert.equal(
        response.generation!.task.runId,
        committed.committed.binding.runId,
      );
      assert.equal(response.generation!.task.pluginId, "crewon.comfyui-krea2");
      assert.notEqual(response.generation!.task.pluginId, f.source.pluginId);
      assert.equal(
        response.generation!.task.operations[0]!.operationRevision,
        committed.operation.revision,
      );
      assert.deepEqual(
        response.generation!.task.operations[0]!.images.map(
          (image) => image.resultIndex,
        ),
        [0, 1],
      );
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(f.creditScope), balance);
      assert.equal(f.state.peerCalls, 0);
      assert.equal(f.state.unknownCalls, 0);
      assert.equal(f.policy.hostCalls, 0);
      const replacement = createProductionPluginUiRuntime(
        {
          configuration: f.configuration,
          ownedProjectGenerationReadActions: f.readRuntime.owner,
        },
        {
          ledger: f.ledger,
          clock: { now: () => new Date().toISOString() },
          fetch: f.fetch,
        },
      );
      t.after(() => replacement.close());
      const restored = await replacement.service.openMount(f.actor, {
        pluginId: f.source.pluginId,
        contributionId: "workbench",
        expectedSelectionRevision: f.selected.selection.revision,
        expectedPackageDigest: f.source.packageDigest,
      });
      const recovered = await f.readRuntime.invokeAuthenticatedRequest(
        f.request,
        f.actor,
        f.command(restored.mountRef),
        undefined,
        () => replacement.service.invoke(f.actor, f.command(restored.mountRef)),
      );
      assert.deepEqual(recovered, result.json().output);
    },
  );

  test(
    `${backend}: current source UI policy, original Run/project gates, token/profile and declared input each fail closed`,
    options,
    async (t) => {
      const f = await generationReadPluginFixture(t, backend);
      await f.commitGenerationWithResult();
      const lease = await f.mount();
      for (const denied of [
        "project",
        "run",
        "ui",
        "token",
        "profile",
      ] as const) {
        f.policy.deniedProject = denied === "project";
        f.policy.deniedTask = denied === "run" ? "run:read" : "";
        f.state.uiAllowed = denied !== "ui";
        f.state.actor =
          denied === "token"
            ? { ...f.actor, principalId: "foreign-person" }
            : f.actor;
        f.state.profile =
          denied === "profile"
            ? { ...f.profile, profileId: "foreign-profile" }
            : f.profile;
        const response = await f.invoke(lease.mountRef);
        assert.notEqual(
          response.statusCode,
          200,
          `${denied}: ${response.body}`,
        );
      }
      f.policy.deniedProject = false;
      f.policy.deniedTask = "";
      f.state.uiAllowed = true;
      f.state.actor = f.actor;
      f.state.profile = f.profile;
      const forged = await f.invoke(lease.mountRef, {
        ...f.command(lease.mountRef),
        input: {
          ...(f.command(lease.mountRef).input as object),
          pluginId: "browser-target",
          runId: "browser-run",
        },
      });
      assert.notEqual(forged.statusCode, 200);
      assert.equal(f.state.peerCalls, 0);
      assert.equal(f.state.unknownCalls, 0);
    },
  );

  for (const withdrawal of ["close", "selection", "token"] as const)
    test(
      `${backend}: ordinary result is withdrawn after ${withdrawal} during actual SQL read`,
      options,
      async (t) => {
        const f = await generationReadPluginFixture(t, backend);
        await f.commitGenerationWithResult();
        const lease = await f.mount();
        const original = f.metadata.loadProject.bind(f.metadata);
        let entered!: () => void, release!: () => void;
        const held = new Promise<void>((done) => {
            release = done;
          }),
          started = new Promise<void>((done) => {
            entered = done;
          });
        t.mock.method(
          f.metadata,
          "loadProject",
          async (...args: Parameters<typeof original>) => {
            entered();
            await held;
            return original(args[0]!);
          },
        );
        const pending = f.invokeDirect(f.command(lease.mountRef));
        await started;
        const close =
          withdrawal === "close" ? f.readRuntime.close() : undefined;
        if (withdrawal === "selection")
          await f.ledger.commitSelection(
            selectionRecipe(f.selected.selection, "withdraw-read-source", {
              actor: f.actor,
              state: "disabled",
            }),
          );
        if (withdrawal === "token")
          f.state.actor = { ...f.actor, principalId: "late-token-owner" };
        release();
        await assert.rejects(pending);
        await close;
        assert.equal(f.state.peerCalls, 0);
      },
    );

  test(
    `${backend}: read-only captured request scope rejects execution and unknown preparation before peer preparation`,
    options,
    async (t) => {
      const f = await generationReadPluginFixture(t, backend);
      const scope = captureInstalledPluginReadRequestScope(f.reads);
      for (const preparation of ["execution", "future"])
        await assert.rejects(async () =>
          scope.run(
            {
              request: f.request,
              actor: f.actor,
              preparation,
            } as never,
            async () => true,
          ),
        );
      assert.equal(f.state.peerCalls, 0);
      assert.equal(
        await scope.run(
          { request: f.request, actor: f.actor },
          async () => true,
        ),
        true,
      );
      assert.equal(f.state.peerCalls, 0);
    },
  );
}

test("read UI runtime rejects structural services and unapproved sources before current identity/storage calls", async () => {
  assert.throws(
    () =>
      createProductionProjectGenerationReadPluginRuntime({
        identity: {},
        reads: {},
        taskReads: {},
      } as never),
    /composition_invalid/u,
  );
});

test(
  "actual production factory assembles configuration-only history reads before source recovery, survives restart and stays disabled without explicit read UI config",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 60000 },
  async (t) => {
    const f = await generationReadPluginFixture(t, "postgres");
    const original = await f.commitGenerationWithResult();
    t.mock.method(globalThis, "fetch", f.fetch);
    const open = (readUi = true) =>
      createProductionPostgresControlApi({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
        schema: f.schema,
        maxPoolSize: 1,
        statementTimeoutMs: 5000,
        identity: f.identity,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "read-ui-fixture-key",
        ...projectPluginDisabledScans,
        creativeProjects: {
          authorization: { authorize: async () => ({ outcome: "allow" }) },
          generationReads: { version: "crewon.project-generation-read.v1" },
          ...(readUi
            ? { generationReadUi: { publications: [f.publication] } }
            : {}),
        },
        pluginUi: { configuration: f.configuration },
        pluginInstallation: { configuration: f.installationConfiguration },
        pluginConfiguration: {
          configuration: parseInstalledPluginConfigurationConfig(
            { ...configDocument, installRoot: f.configuration.installRoot },
            environment,
          ),
        },
      });
    const mount = async (app: Awaited<ReturnType<typeof open>>["app"]) => {
      const recovered = await app.inject({
        method: "GET",
        url: `/api/v1/plugins/selections/${f.source.pluginId}`,
        headers: f.request.headers,
      });
      assert.equal(recovered.statusCode, 200, recovered.body);
      assert.equal(recovered.json().selection.state, "enabled");
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/plugins/ui/mounts",
        headers: f.request.headers,
        payload: {
          pluginId: f.source.pluginId,
          contributionId: "workbench",
          expectedSelectionRevision: f.selected.selection.revision,
          expectedPackageDigest: f.source.packageDigest,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().mountRef as string;
    };
    const read = (
      app: Awaited<ReturnType<typeof open>>["app"],
      mountRef: string,
    ) =>
      app.inject({
        method: "POST",
        url: `/api/v1/plugins/ui/mounts/${mountRef}/actions`,
        headers: f.request.headers,
        payload: {
          action: f.command(mountRef).action,
          input: f.command(mountRef).input,
        },
      });
    const before = await f.counts(),
      account = await f.credits.getAccount(f.creditScope);
    for (let restart = 0; restart < 2; restart++) {
      const runtime = await open();
      try {
        const mountRef = await mount(runtime.app),
          response = await read(runtime.app, mountRef);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(
          f.decode(f.command(mountRef), response.json().output).generation!.task
            .runId,
          original.committed.binding.runId,
        );
      } finally {
        await runtime.app.close();
      }
    }
    const disabled = await open(false);
    try {
      const mountRef = await mount(disabled.app),
        response = await read(disabled.app, mountRef);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, "plugin_ui_actions_unavailable");
    } finally {
      await disabled.app.close();
    }
    assert.deepEqual(await f.counts(), before);
    assert.deepEqual(await f.credits.getAccount(f.creditScope), account);
    assert.equal(f.state.peerCalls, 0);
    assert.equal(f.state.unknownCalls, 0);
  },
);
