import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectWorkspaceTargetRequest as request,
  parseProjectWorkspaceTargetResponse as response,
} from "./plugin-project-workspace-target.ts";

test("workspace target discovery identifies only the requested project and an opaque host ID", () => {
  const input = request({ projectId: "project-1" });
  const output = response(
    {
      projectId: input.projectId,
      workspaceId: `workspace-project-${"a".repeat(64)}`,
    },
    input,
  );
  assert.ok(Object.isFrozen(input));
  assert.ok(Object.isFrozen(output));
  for (const extra of [
    { owner: {} },
    { root: "/tmp" },
    { registered: true },
    { permission: "project.execute" },
  ]) {
    assert.throws(() => request({ ...input, ...extra }));
    assert.throws(() => response({ ...output, ...extra }, input));
  }
  assert.throws(() =>
    response({ ...output, projectId: "other-project" }, input),
  );
  assert.throws(() =>
    response({ ...output, workspaceId: "ordinary-workspace" }, input),
  );
  let called = false;
  assert.throws(() =>
    request({
      get projectId() {
        called = true;
        return input.projectId;
      },
    }),
  );
  assert.equal(called, false);
});
