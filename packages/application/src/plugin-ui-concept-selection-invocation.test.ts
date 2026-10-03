import assert from "node:assert/strict";
import test from "node:test";
import { taskActor } from "./extension-plugin-task.test-support.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";

test("only the exact concept selection mutation captures real current UI transaction qualification", async () => {
  for (const action of [
    "crewon.project-generation-selections.v1.selectConceptImage",
    "crewon.project-generation-selections.v1.getConceptSelection",
    "crewon.project-generation-selections.v1.arbitraryMutation",
  ]) {
    const f = committedUiFixture();
    f.state.mode = "json";
    const lease = await f.service.openMount(taskActor, f.openCommand);
    f.state.afterAction = async () => {
      const authority = capturePluginUiInvocationCommitAuthority(
        f.state.context!,
      );
      if (action.endsWith(".selectConceptImage")) {
        assert.ok(authority.transaction);
        assert.equal(authority.transaction.pin.action, action);
        assert.equal(
          authority.transaction.package.packageDigest,
          lease.packageDigest,
        );
        assert.equal(
          authority.transaction.selection.revision,
          lease.selectionRevision,
        );
        await authority.transaction.assertCurrent();
      } else assert.equal(authority.transaction, undefined);
    };
    await f.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action,
      input: null,
    });
    assert.throws(
      () => capturePluginUiInvocationCommitAuthority(f.state.context!),
      { code: "plugin_ui_invocation_unavailable" },
    );
  }
});

test("selection transaction current fence uses captured source pin and fails when mount closes", async () => {
  const f = committedUiFixture();
  f.state.mode = "json";
  const lease = await f.service.openMount(taskActor, f.openCommand);
  f.state.afterAction = async () => {
    const authority = capturePluginUiInvocationCommitAuthority(
      f.state.context!,
    );
    assert.ok(authority.transaction);
    await f.service.closeMount(taskActor, { mountRef: lease.mountRef });
    await assert.rejects(authority.transaction.assertCurrent(), {
      code: "plugin_ui_mount_unavailable",
    });
    assert.throws(() => authority.assertActive(), {
      code: "plugin_ui_mount_unavailable",
    });
  };
  await assert.rejects(
    f.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: "crewon.project-generation-selections.v1.selectConceptImage",
      input: null,
    }),
    { code: "plugin_ui_mount_unavailable" },
  );
});
