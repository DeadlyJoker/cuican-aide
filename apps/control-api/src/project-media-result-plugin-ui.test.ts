import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  PluginUiApplicationService,
  type PluginUiActionContext,
} from "@crewon/application";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  PROJECT_MEDIA_RESULT_UI_ACTIONS as actions,
  PROJECT_MEDIA_RESULT_WRITE_ACTIONS as writes,
} from "@crewon/contracts/project-media-results-ui";
import { uiTestDescriptor } from "../../../packages/application/src/plugin-ui.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaResultControlFixture } from "./project-media-result-control.test-support.ts";
import { ProjectMediaResultPluginUiOwner } from "./project-media-result-plugin-ui-owner.ts";

/** Actual media Run/SQL/archive/Core and genuine UI registration; UI package verifier and PDP are named fixtures. */
async function fixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  declared = true,
  wrongPublication = false,
  options: { writeDeclared?: boolean; readOnly?: boolean } = {},
) {
  const f = await mediaResultControlFixture(t, backend);
  const published = await f.client.projectMediaResults.publish(f.query);
  const control = options.readOnly
    ? await f.openControl(f.parent, ["read"])
    : f;
  const descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    pluginId: f.target.package.pluginId,
    publisherId: f.target.package.publisherId,
    version: f.target.package.version,
    entrypoints: { node: null, ui: { path: "ui.mjs", mode: "trustedModule" } },
    files: uiTestDescriptor.files.filter((x) => x.path === "ui.mjs"),
    requires: declared
      ? [
          ...(options.writeDeclared === false
            ? []
            : [
                {
                  service: "crewon.project-media-result-actions",
                  apiVersion: "1",
                  optional: true,
                },
              ]),
          {
            service: "crewon.project-media-results",
            apiVersion: "1",
            optional: true,
          },
        ]
      : [],
  });
  const state = {
    allowed: true,
    contexts: [] as PluginUiActionContext[],
    afterInvoke: undefined as (() => void) | undefined,
  };
  const owner = new ProjectMediaResultPluginUiOwner({
    runtime: control.owner,
    configuration: {
      publications: [
        {
          pluginId: f.pin.pluginId,
          packageDigest: wrongPublication
            ? "sha256:" + "f".repeat(64)
            : f.pin.packageDigest,
          contributionId: "workbench",
        },
      ],
    },
  });
  t.after(() => owner.close());
  const ui = new PluginUiApplicationService({
    store: f.parent.pluginInstallationStore(),
    profiles: {
      resolve: async () => ({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        profileId: f.controlState.profileId,
      }),
    },
    authorization: {
      authorize: async () =>
        state.allowed
          ? { outcome: "allow", authorityEpoch: "result-ui-test" }
          : { outcome: "deny", reasonCode: "withdrawn" },
    },
    packages: {
      verify: async () => ({ descriptor, publicAssets: ["ui.mjs"] }),
      readAsset: async () => ({
        bytes: new Uint8Array([1]),
        contentType: "text/javascript",
      }),
    },
    clock: f.dependencies.clock,
    ids: { nextId: () => randomUUID().replaceAll("-", "") + "m".repeat(16) },
    committedMetadata: owner.committedMetadata,
    actions: {
      invoke: async (context) => {
        state.contexts.push(context);
        const output = await owner.actions.invoke(context);
        state.afterInvoke?.();
        return output;
      },
    },
  });
  const mount = await ui.openMount(f.actor, {
    pluginId: f.pin.pluginId,
    contributionId: "workbench",
    expectedSelectionRevision: f.target.selection.revision,
    expectedPackageDigest: f.pin.packageDigest,
  });
  const invoke = (
    action: string,
    input: import("@crewon/contracts/plugins").PluginUiJsonValue,
  ) =>
    control.requests.run(
      {
        request: f.controlRequest,
        actor: f.actor,
        preparation: "configuration",
      },
      () => ui.invoke(f.actor, { mountRef: mount.mountRef, action, input }),
    );
  return { ...f, published, uiOwner: owner, ui, mount, invoke, stateUi: state };
}
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: plugin result reads share verified original media, no output network or writes`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const before = await f.count(),
        gets = f.controlState.gets;
      f.controlState.network = false;
      const list = await f.invoke(actions.listCandidates, {
        projectId: f.query.projectId,
        afterCandidateId: null,
        limit: 16,
      });
      assert.deepEqual(list, {
        candidates: [f.published.candidate],
        nextCandidateId: null,
      });
      assert.deepEqual(await f.invoke(actions.preview, f.query), {
        candidate: f.published.candidate,
      });
      assert.equal(await f.count(), before);
      assert.equal(f.controlState.gets, gets);
      assert.equal(JSON.stringify(list).includes("https:"), false);
      const context = f.stateUi.contexts[0]!;
      assert.throws(
        () => f.uiOwner.actions.invoke(context),
        /invocation_unavailable/,
      );
      assert.throws(
        () => f.uiOwner.actions.invoke({ ...context }),
        /invocation_unavailable/,
      );
      assert.throws(
        () =>
          f.uiOwner.actions.invoke(
            new Proxy({} as PluginUiActionContext, {
              get() {
                throw new Error("must_not_read");
              },
            }),
          ),
        /invocation_unavailable/,
      );
      f.controlState.profileId = "other-profile";
      await assert.rejects(
        f.invoke(actions.listCandidates, {
          projectId: f.query.projectId,
          afterCandidateId: null,
          limit: 16,
        }),
      );
    },
  );
  test(
    `${backend}: undeclared or differently published UI cannot read results; closed owner and mount fail closed`,
    assetTestOptions(backend),
    async (t) => {
      for (const [declared, wrong] of [
        [false, false],
        [true, true],
        [true, false],
      ]) {
        const f = await fixture(t, backend, declared, wrong);
        if (declared && !wrong)
          await f.ui.closeMount(f.actor, { mountRef: f.mount.mountRef });
        await assert.rejects(f.invoke(actions.preview, f.query));
        await f.uiOwner.close();
        await assert.rejects(f.invoke(actions.preview, f.query));
      }
    },
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: plugin discovers original output positions and saves one candidate with exact replay`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const run = { projectId: f.query.projectId, runId: f.query.runId };
      const before = await f.referenceSource(),
        material = f.materialCounts(),
        gets = f.controlState.gets;
      const outputs = (await f.invoke(writes.listOutputs, run)) as {
        outputs: { resultIndex: number; candidate: unknown }[];
      };
      assert.deepEqual(outputs.outputs, [
        { resultIndex: 0, candidate: f.published.candidate },
        { resultIndex: 1, candidate: null },
      ]);
      assert.equal(f.controlState.gets, gets);
      assert.equal(JSON.stringify(outputs).includes("https:"), false);
      const query = { ...f.query, resultIndex: 1 };
      const saved = (await f.invoke(writes.saveCandidate, query)) as {
        disposition: string;
        candidate: unknown;
      };
      assert.equal(saved.disposition, "created");
      const replay = await f.invoke(writes.saveCandidate, query);
      assert.deepEqual(replay, {
        disposition: "replayed",
        candidate: saved.candidate,
      });
      assert.equal(await f.count(), 2);
      assert.equal(f.controlState.gets, gets + 1);
      assert.deepEqual(await f.referenceSource(), before);
      assert.deepEqual(f.materialCounts(), material);
      await assert.rejects(
        f.invoke(writes.saveCandidate, { ...query, resultIndex: 2 }),
      );
      assert.equal(await f.count(), 2);
      const context = f.stateUi.contexts.find(
        (c) => c.action === writes.saveCandidate,
      )!;
      assert.throws(
        () => f.uiOwner.actions.invoke({ ...context }),
        /invocation_unavailable/,
      );
    },
  );
  test(
    `${backend}: read-only runtime and missing write declaration cannot save or advertise result actions`,
    assetTestOptions(backend),
    async (t) => {
      for (const options of [{ writeDeclared: false }, { readOnly: true }]) {
        const f = await fixture(t, backend, true, false, options),
          gets = f.controlState.gets;
        await assert.rejects(
          f.invoke(writes.saveCandidate, { ...f.query, resultIndex: 1 }),
        );
        await assert.rejects(
          f.invoke(writes.listOutputs, {
            projectId: f.query.projectId,
            runId: f.query.runId,
          }),
        );
        assert.equal(await f.count(), 1);
        assert.equal(f.controlState.gets, gets);
        assert.deepEqual(await f.invoke(actions.preview, f.query), {
          candidate: f.published.candidate,
        });
      }
    },
  );
  test(
    `${backend}: withdrawal during output download or original INSERT prevents candidate commit`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        query = { ...f.query, resultIndex: 1 };
      f.controlState.onGet = async () => {
        f.stateUi.allowed = false;
      };
      await assert.rejects(f.invoke(writes.saveCandidate, query));
      assert.equal(await f.count(), 1);
      f.stateUi.allowed = true;
      f.controlState.onGet = undefined;
      let closing: Promise<void> | undefined;
      const restore = observeMaterialPreparationSql(
        backend,
        /INSERT INTO .*project_media_result_candidates/u,
        () => {
          closing = f.uiOwner.close();
        },
      );
      try {
        await assert.rejects(f.invoke(writes.saveCandidate, query));
      } finally {
        restore();
      }
      assert.ok(closing);
      await closing;
      assert.equal(await f.count(), 1);
    },
  );
  test(
    `${backend}: a committed UI save survives a late policy withdrawal and can be recovered by its original position`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        query = { ...f.query, resultIndex: 1 };
      f.stateUi.afterInvoke = () => {
        f.stateUi.allowed = false;
      };
      const output = (await f.invoke(writes.saveCandidate, query)) as {
        disposition: string;
        candidate: unknown;
      };
      assert.equal(output.disposition, "created");
      assert.equal(await f.count(), 2);
      f.stateUi.allowed = true;
      f.stateUi.afterInvoke = undefined;
      f.controlState.network = false;
      assert.deepEqual(await f.invoke(writes.saveCandidate, query), {
        disposition: "replayed",
        candidate: output.candidate,
      });
    },
  );
}
