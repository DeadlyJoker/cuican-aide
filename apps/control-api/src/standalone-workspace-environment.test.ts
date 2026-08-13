import assert from "node:assert/strict";
import test from "node:test";

import { resolveStandaloneWorkspaceWorkerEnvironment } from "./standalone-workspace-environment.ts";

const TOKEN = "workspace-worker-token-000000000001";

test("projects an all-or-none standalone loopback Workspace worker", () => {
  assert.equal(
    resolveStandaloneWorkspaceWorkerEnvironment({}, "standalone"),
    undefined,
  );
  assert.deepEqual(
    resolveStandaloneWorkspaceWorkerEnvironment(
      {
        CREWON_WORKSPACE_WORKER_ORIGIN: "http://127.0.0.1:43125",
        CREWON_WORKSPACE_WORKER_TOKEN: TOKEN,
        CREWON_WORKSPACE_BINDING_ID: "workspace-binding-1",
        CREWON_WORKSPACE_WORKER_DEADLINE_MS: "40000",
      },
      "standalone",
    ),
    {
      origin: "http://127.0.0.1:43125",
      token: TOKEN,
      workspaceBindingId: "workspace-binding-1",
      deadlineMs: 40_000,
    },
  );
});

test("rejects incomplete, non-loopback, and malformed standalone routes", () => {
  for (const environment of [
    { CREWON_WORKSPACE_WORKER_ORIGIN: "http://127.0.0.1:43125" },
    { CREWON_WORKSPACE_WORKER_TOKEN: TOKEN },
    { CREWON_WORKSPACE_WORKER_DEADLINE_MS: "40000" },
    { CREWON_WORKSPACE_BINDING_ID: "workspace-binding-1" },
    {
      CREWON_WORKSPACE_WORKER_ORIGIN: "http://localhost:43125",
      CREWON_WORKSPACE_WORKER_TOKEN: TOKEN,
      CREWON_WORKSPACE_BINDING_ID: "workspace-binding-1",
    },
    {
      CREWON_WORKSPACE_WORKER_ORIGIN: "http://127.0.0.1:43125/path",
      CREWON_WORKSPACE_WORKER_TOKEN: TOKEN,
      CREWON_WORKSPACE_BINDING_ID: "workspace-binding-1",
    },
    {
      CREWON_WORKSPACE_WORKER_ORIGIN: "http://127.0.0.1:43125",
      CREWON_WORKSPACE_WORKER_TOKEN: "short",
      CREWON_WORKSPACE_BINDING_ID: "workspace-binding-1",
    },
    {
      CREWON_WORKSPACE_WORKER_ORIGIN: "http://127.0.0.1:43125",
      CREWON_WORKSPACE_WORKER_TOKEN: TOKEN,
      CREWON_WORKSPACE_BINDING_ID: "workspace-binding-1",
      CREWON_WORKSPACE_WORKER_DEADLINE_MS: "60001",
    },
  ]) {
    assert.throws(() =>
      resolveStandaloneWorkspaceWorkerEnvironment(environment, "standalone"),
    );
  }
});

test("forbids every ambient Workspace worker variable in production", () => {
  for (const environment of [
    { CREWON_WORKSPACE_WORKER_ORIGIN: "http://127.0.0.1:43125" },
    { CREWON_WORKSPACE_WORKER_TOKEN: TOKEN },
    { CREWON_WORKSPACE_WORKER_DEADLINE_MS: "40000" },
    { CREWON_WORKSPACE_WORKER_TOKEN: "" },
    { CREWON_WORKSPACE_BINDING_ID: "workspace-binding-1" },
  ]) {
    assert.throws(
      () =>
        resolveStandaloneWorkspaceWorkerEnvironment(environment, "production"),
      /CREWON_WORKSPACE_WORKER_CONFIGURATION_forbidden/u,
    );
  }
});
