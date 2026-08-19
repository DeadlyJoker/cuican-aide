import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { resolveRuntimeProductionWorkspaceEnvironment } from "./runtime-production-workspace-environment.ts";

const TOKEN = "production-workspace-token-at-least-32-bytes";

test("production parses one exact secret-referenced Workspace deployment", () => {
  assert.equal(
    resolveRuntimeProductionWorkspaceEnvironment({}, "production"),
    undefined,
  );
  const parsed = resolveRuntimeProductionWorkspaceEnvironment(
    environment(),
    "production",
  );
  assert.deepEqual(parsed, {
    trustedLocalPath: resolve("workspace-root"),
    deadlineMs: 35_000,
    privateServer: { port: 43125, token: TOKEN },
    authority: authority(),
  });
});

test("production deployment example is accepted by the release and worker parser", () => {
  const environment = environmentFile(
    readFileSync(
      new URL(
        "../../../deploy/crewon/runtime.production.env.example",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    resolveRuntimeProductionWorkspaceEnvironment(environment, "production"),
    {
      trustedLocalPath: "/workspace",
      deadlineMs: 30_000,
      privateServer: {
        port: 3222,
        token: "<different-at-least-32-random-bytes>",
      },
      authority: {
        tenantId: "tenant-1",
        spaceId: "space-1",
        workspaceBindingId: "workspace-1",
        incarnationId: "workspace-incarnation-1",
        runtimeBindingId: "runtime-1",
        policySnapshotId: "policy-1",
      },
    },
  );
});

test("production rejects desktop flags, missing secrets, and authority drift", () => {
  assert.throws(
    () =>
      resolveRuntimeProductionWorkspaceEnvironment(
        { CREWON_NATIVE_WORKSPACE_READ_ENABLED: "1" },
        "production",
      ),
    /CREWON_NATIVE_WORKSPACE_READ_ENABLED_forbidden/u,
  );
  assert.throws(
    () =>
      resolveRuntimeProductionWorkspaceEnvironment(environment(), "standalone"),
    /CREWON_RUNTIME_WORKSPACE_CONFIG_JSON_forbidden/u,
  );
  for (const candidate of [
    { ...config(), extra: true },
    { ...config(), trustedLocalPath: "relative" },
    {
      ...config(),
      privateServer: { port: 43125, tokenEnvironment: "MISSING_TOKEN" },
    },
    { ...config(), authority: { ...authority(), runtimeBindingId: "" } },
  ]) {
    assert.throws(
      () =>
        resolveRuntimeProductionWorkspaceEnvironment(
          {
            CREWON_RUNTIME_WORKSPACE_CONFIG_JSON: JSON.stringify(candidate),
            WORKSPACE_PRIVATE_TOKEN: TOKEN,
          },
          "production",
        ),
      /CREWON_RUNTIME_WORKSPACE_CONFIG_JSON_invalid/u,
    );
  }
});

function environment() {
  return {
    CREWON_RUNTIME_WORKSPACE_CONFIG_JSON: JSON.stringify(config()),
    WORKSPACE_PRIVATE_TOKEN: TOKEN,
  };
}

function config() {
  return {
    schemaVersion: "crewon.runtime-workspace.v0",
    trustedLocalPath: resolve("workspace-root"),
    deadlineMs: 35_000,
    privateServer: {
      port: 43125,
      tokenEnvironment: "WORKSPACE_PRIVATE_TOKEN",
    },
    authority: authority(),
  };
}

function authority() {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    runtimeBindingId: "runtime-generation-1",
    policySnapshotId: "policy-1",
  };
}

function environmentFile(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        assert.notEqual(separator, -1);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}
