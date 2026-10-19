import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "@crewon/application";
import { PROJECT_GENERATION_CONTEXT_UI_ACTIONS } from "@crewon/contracts/plugins";
import { assertPluginUiHostServiceAvailability } from "@crewon/plugin-host";
import { InstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";
import { runPluginGenerationDiagnostics } from "./installed-plugin-invocation-diagnostics.ts";
import {
  installedGenerationFixture,
  actor,
  creditScope,
} from "./installed-plugin-project-generation-owner.test-support.ts";
import { deferred } from "./installed-plugin-task-action-owner.test-support.ts";

const action = PROJECT_GENERATION_CONTEXT_UI_ACTIONS[0];
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30_000,
  };
  test(
    `${backend} actual installed business UI checks saved generation readiness on its original invocation without Node, quote, Run or credits`,
    options,
    async (t) => {
      const f = await installedGenerationFixture(t, backend, {
        contexts: true,
      });
      const before = await f.counts(),
        account = await f.credits.getAccount(creditScope);
      const output = await runPluginGenerationDiagnostics(
        `req-readiness${backend}`,
        action,
        () => f.invoke({ reference: f.reference }, action),
      );
      assert.deepEqual(output, {
        reference: f.reference,
        readiness: { outcome: "ready" },
      });
      assert.ok(
        f.state.packagePurposes.some((item) => item.pluginId === f.sourceId),
      );
      assert.ok(
        f.state.packagePurposes.every(
          (item) =>
            item.purpose === (item.pluginId === f.sourceId ? "read" : "submit"),
        ),
      );
      assert.equal(f.state.lastContext?.action, action);
      assert.equal(f.state.lastContext?.package.pluginId, f.sourceId);
      assert.equal(f.state.lastContext?.lease, f.lease);
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.state.submissions.length, 0);
      assert.equal(f.nodeState.setups, 0);
      assert.equal(f.nodeState.calls, 0);
      assert.equal(f.nodeState.quoteCalls, 0);
      assert.equal(JSON.stringify(output).includes("executionPin"), false);
      assert.equal(
        JSON.stringify(output).includes(f.installed.packageDigest),
        false,
      );
      assertPluginUiHostServiceAvailability({
        scope: f.profile,
        candidate: {
          descriptor: f.source.descriptor,
          packageDigest: f.source.packageDigest,
        },
        hostUiServices: f.owner.hostUiServices,
      });
    },
  );

  test(
    `${backend} same-package readiness still requires submit after source read succeeds`,
    options,
    async (t) => {
      const f = await installedGenerationFixture(t, backend, {
        contexts: true,
        samePackage: true,
      });
      assert.equal(f.sourceId, f.installed.descriptor.pluginId);
      assert.equal(f.source.packageDigest, f.installed.packageDigest);
      assert.deepEqual(await f.invoke({ reference: f.reference }, action), {
        reference: f.reference,
        readiness: { outcome: "ready" },
      });
      assert.ok(f.state.packagePurposes.length >= 2);
      assert.deepEqual(f.state.packagePurposes.slice(0, 2), [
        { pluginId: f.sourceId, purpose: "read" },
        { pluginId: f.sourceId, purpose: "submit" },
      ]);
      f.state.targetPackageAllowed = false;
      const before = await f.counts();
      await assert.rejects(
        f.invoke({ reference: f.reference }, action),
        /project_generation_execution_package_denied/,
      );
      assert.deepEqual(await f.counts(), before);
      assert.equal(f.nodeState.setups, 0);
      assert.equal(f.nodeState.calls, 0);
      assert.equal(f.nodeState.quoteCalls, 0);
    },
  );

  for (const denied of ["source-read", "target-submit"] as const)
    test(
      `${backend} readonly readiness rejects missing ${denied} permission before Node or task allocation`,
      options,
      async (t) => {
        const f = await installedGenerationFixture(t, backend, {
          contexts: true,
        });
        if (denied === "source-read") f.state.sourcePackageAllowed = false;
        else f.state.targetPackageAllowed = false;
        const before = await f.counts();
        await assert.rejects(
          f.invoke({ reference: f.reference }, action),
          (error: unknown) =>
            error instanceof ApplicationError &&
            error.code === "project_generation_execution_package_denied",
        );
        assert.deepEqual(await f.counts(), before);
        assert.equal(f.nodeState.calls, 0);
        assert.equal(f.nodeState.setups, 0);
        assert.equal(f.nodeState.quoteCalls, 0);
        assert.equal(f.state.submissions.length, 0);
      },
    );

  test(
    `${backend} exact saved CAS and archive produce input-unavailable, not an admission or generated record`,
    options,
    async (t) => {
      const f = await installedGenerationFixture(t, backend, {
        contexts: true,
      });
      const reference = {
        ...f.reference,
        expectedProjectRevision: f.reference.expectedProjectRevision + 1,
      };
      assert.deepEqual(await f.invoke({ reference }, action), {
        reference,
        readiness: {
          outcome: "unavailable",
          reasonCode: "project_generation_input_unavailable",
        },
      });
      await f.projectService.setProjectState(actor, {
        projectId: f.reference.projectId,
        expectedProjectRevision: f.concept.project.revision,
        state: "archived",
        idempotencyKey: "readiness-archive",
      });
      assert.deepEqual(await f.invoke({ reference: f.reference }, action), {
        reference: f.reference,
        readiness: {
          outcome: "unavailable",
          reasonCode: "project_generation_input_unavailable",
        },
      });
      assert.equal(f.nodeState.calls, 0);
      assert.equal(f.nodeState.quoteCalls, 0);
    },
  );

  for (const change of [
    "source-policy",
    "target-policy",
    "source-package",
    "target-package",
    "source-selection",
    "target-selection",
    "mount-close",
    "owner-close",
    "request-abort",
  ] as const)
    test(
      `${backend} readonly readiness rejects ${change} during actual saved-source lookup`,
      options,
      async (t) => {
        const f = await installedGenerationFixture(t, backend, {
          contexts: true,
        });
        const entered = deferred(),
          release = deferred();
        const original = f.projects.loadProject.bind(f.projects);
        let first = true;
        f.projects.loadProject = async (
          input: Parameters<typeof original>[0],
        ) => {
          const result = await original(input);
          if (first) {
            first = false;
            entered.resolve();
            await release.promise;
          }
          return result;
        };
        const before = await f.counts(),
          account = await f.credits.getAccount(creditScope);
        const pending = f.invoke({ reference: f.reference }, action);
        void pending.catch(() => {});
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("readiness_finished_before_saved_source_gate");
          }),
        ]);
        let closing: Promise<void> | undefined;
        if (change === "source-policy")
          f.state.sourceEpoch = "withdrawn-source";
        if (change === "target-policy")
          f.state.targetEpoch = "withdrawn-target";
        if (change === "source-package") f.state.sourcePackageAllowed = false;
        if (change === "target-package") f.state.targetPackageAllowed = false;
        if (change === "source-selection") await f.selection("source");
        if (change === "target-selection") await f.selection("target");
        if (change === "mount-close")
          await f.service.closeMount(actor, { mountRef: f.lease.mountRef });
        if (change === "owner-close") closing = f.owner.close();
        if (change === "request-abort") f.state.request.abort();
        release.resolve();
        await assert.rejects(pending);
        await closing;
        assert.deepEqual(await f.counts(), before);
        assert.deepEqual(await f.credits.getAccount(creditScope), account);
        assert.equal(f.nodeState.setups, 0);
        assert.equal(f.nodeState.quoteCalls, 0);
      },
    );
}

test("legacy generation descriptor does not gain the new read action; owner rejects fake pair before configuration or source reads", async (t) => {
  const f = await installedGenerationFixture(t);
  await assert.rejects(
    f.invoke({ reference: f.reference }, action),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "plugin_project_generation_context_invalid",
  );
  assert.throws(
    () =>
      new InstalledPluginProjectGenerationOwner({
        ...f.dependencies,
        committedTasks: {} as never,
      }),
  );
  assert.equal(f.nodeState.setups, 0);
  assert.equal(f.nodeState.quoteCalls, 0);
});
