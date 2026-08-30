import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceWorkerRuntimeAuthorizer } from "./workspace-worker-runtime-authorizer.ts";

const identity = {
  workerId: "worker-1",
  credentialId: "credential-1",
  authenticationMethod: "mtls" as const,
  authenticatedAt: "2026-08-09T00:00:00.000Z",
};

test("binds exact Worker credential to an explicitly allowed runtime", () => {
  const authorizer = new WorkspaceWorkerRuntimeAuthorizer([
    {
      workerId: "worker-1",
      credentialId: "credential-1",
      fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
      allowedRuntimeBindingIds: ["runtime-binding-1"],
    },
  ]);
  assert.doesNotThrow(() =>
    authorizer.authorize(identity, "runtime-binding-1"),
  );
  for (const forged of [
    { ...identity, workerId: "worker-2" },
    { ...identity, credentialId: "credential-2" },
  ]) {
    assert.throws(
      () => authorizer.authorize(forged, "runtime-binding-1"),
      hasCode("workspace_worker_runtime_unauthorized"),
    );
  }
  assert.throws(
    () => authorizer.authorize(identity, "runtime-binding-2"),
    hasCode("workspace_worker_runtime_unauthorized"),
  );
});

test("legacy Worker registrations default to no Workspace runtime access", () => {
  const authorizer = new WorkspaceWorkerRuntimeAuthorizer([
    {
      workerId: "worker-1",
      credentialId: "credential-1",
      fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
    },
  ]);
  assert.throws(
    () => authorizer.authorize(identity, "runtime-binding-1"),
    hasCode("workspace_worker_runtime_unauthorized"),
  );
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
