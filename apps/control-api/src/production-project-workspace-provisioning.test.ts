import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProductionProjectWorkspaceProvisioning } from "./production-project-workspace-provisioning.ts";
import { qualifyPluginProjectWorkspaceNativeObservation } from "@crewon/application";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import { ownedConversationUiFixture } from "../../../packages/store/src/project-conversation-ui-owned.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: actual shared Host allocation records the original namespace and creates one isolated conversation across cold replay`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await ownedConversationUiFixture(
        t,
        "matching",
        "available",
        "nativeIdentity",
        { backend, namespace: "deferred" },
      );
      const root = realpathSync(
          mkdtempSync(join(tmpdir(), "crewon-host-allocation-")),
        ),
        installRoot = join(root, "installed");
      mkdirSync(installRoot, { mode: 0o700 });
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const composition = () =>
        createProductionProjectWorkspaceProvisioning({
          installRoot,
          registration:
            f.parent.pluginProjectWorkspaceNativeRegistrationStore(),
          assertActive() {
            if (!f.state.hostActive) throw new Error("host_closed");
          },
        });
      let provisioning = composition();
      f.state.prepareWorkspace = true;
      f.state.onWorkspacePrepared = async (p) => {
        const evidence = await provisioning.observe(p);
        await provisioning.registration.recordFromNativeObservation(evidence, {
          createdAt: f.namespaceRecipe().createdAt,
        });
      };
      const first = (await f.invoke(
        actions.createConversation,
        f.createInput,
      )) as { binding: { threadId: string; workspaceId: string } };
      assert.equal(first.binding.workspaceId, f.createInput.workspaceId);
      assert.equal(f.state.threadPreparations, 1);
      assert.equal(f.state.taskCount, 0);
      const directory = join(
        installRoot,
        ".host-project-workspaces",
        "plugin-project-workspaces",
      );
      assert.deepEqual(readdirSync(directory), [first.binding.workspaceId]);
      provisioning = composition();
      const second = (await f.invoke(
        actions.createConversation,
        f.createInput,
      )) as typeof first;
      assert.equal(second.binding.threadId, first.binding.threadId);
      assert.equal(f.state.threadPreparations, 1);
      assert.equal(
        (
          await f.parent
            .pluginProjectWorkspaceNamespaces()
            .listNamespaces({
              owner: f.namespaceScope,
              afterProjectId: null,
              limit: 16,
            })
        ).namespaces.length,
        1,
      );
      assert.deepEqual(readdirSync(directory), [first.binding.workspaceId]);
    },
  );

test("Host observation rejects changed private-root permissions before original namespace/thread commit", async (t) => {
  const f = await ownedConversationUiFixture(
    t,
    "matching",
    "available",
    "nativeIdentity",
    { namespace: "deferred" },
  );
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "crewon-host-private-")),
    ),
    installRoot = join(root, "installed");
  mkdirSync(installRoot, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provisioning = createProductionProjectWorkspaceProvisioning({
    installRoot,
    registration: f.parent.pluginProjectWorkspaceNativeRegistrationStore(),
    assertActive() {},
  });
  f.state.prepareWorkspace = true;
  f.state.onWorkspacePrepared = async (p) => {
    const evidence = await provisioning.observe(p);
    const directory = join(installRoot, ".host-project-workspaces");
    chmodSync(directory, 0o755);
    assert.throws(
      () => qualifyPluginProjectWorkspaceNativeObservation(evidence),
      /host_workspace_unavailable/,
    );
    await assert.rejects(
      provisioning.registration.recordFromNativeObservation(evidence, {
        createdAt: f.namespaceRecipe().createdAt,
      }),
      /host_workspace_unavailable/,
    );
    chmodSync(directory, 0o700);
    throw new Error("named_test_stops_before_thread_commit");
  };
  await assert.rejects(
    f.invoke(actions.createConversation, f.createInput),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      error.cause.message === "named_test_stops_before_thread_commit",
  );
  assert.equal(f.state.threadPreparations, 0);
  assert.equal(
    (
      await f.parent
        .pluginProjectWorkspaceNamespaces()
        .listNamespaces({
          owner: f.namespaceScope,
          afterProjectId: null,
          limit: 16,
        })
    ).namespaces.length,
    0,
  );
});
