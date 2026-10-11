import assert from "node:assert/strict";
import test from "node:test";
import type { CommitExtensionTurnOptions } from "@crewon/application";
import { capturePluginTaskCommitAuthorityOption } from "./plugin-task-commit-authority-option.ts";

test("a counterfeit or inherited opaque Store option cannot bypass the original transaction", () => {
  for (const value of [
    {},
    Object.freeze(Object.create(null)),
    undefined,
    null,
  ]) {
    assert.throws(
      () =>
        capturePluginTaskCommitAuthorityOption({
          pluginTaskCommitAuthority: value,
        } as CommitExtensionTurnOptions),
      /plugin_task_commit_authority_invalid/u,
    );
  }
  assert.throws(
    () =>
      capturePluginTaskCommitAuthorityOption(
        Object.create({ pluginTaskCommitAuthority: {} }),
      ),
    /plugin_task_commit_authority_invalid/u,
  );
});
test("Store option accessors are never evaluated and an absent option preserves the original strict options", () => {
  let reads = 0;
  const raw = Object.defineProperty({}, "pluginTaskCommitAuthority", {
    enumerable: true,
    get() {
      reads++;
      return {};
    },
  });
  assert.throws(
    () => capturePluginTaskCommitAuthorityOption(raw),
    /plugin_task_commit_authority_invalid/u,
  );
  assert.equal(reads, 0);
  const legacy = {
    unrelated: "original parser must still reject this",
  } as CommitExtensionTurnOptions;
  assert.equal(capturePluginTaskCommitAuthorityOption(legacy).options, legacy);
});
