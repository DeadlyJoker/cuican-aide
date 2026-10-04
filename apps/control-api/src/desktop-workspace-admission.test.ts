import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDesktopWorkspaceAdmission,
  resolveDesktopWorkspaceRegistryPath,
} from "./desktop-workspace-admission.ts";
import { createStandaloneControlApi } from "./standalone-composition.ts";
import { InMemoryArtifactStore } from "@crewon/artifacts";

const actor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};
const environmentName = "CREWON_DESKTOP_WORKSPACE_REGISTRY_PATH";

test("actual SQLite HTTP admission preserves workspace ownership across selection and rejects unknown identities", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-workspace-http-"));
  const registryPath = join(directory, "registry.json");
  const registry = {
    schemaVersion: "crewon.desktop-workspace-authority.v2",
    revision: 1,
    activeWorkspaceId: "workspace-a",
    workspaces: [
      { workspaceId: "workspace-a", root: "/private/a" },
      { workspaceId: "workspace-b", root: "/private/b" },
    ],
  };
  writeFileSync(registryPath, JSON.stringify(registry));
  const sessionToken = "workspace-http-session-token-32-characters";
  const csrfToken = "workspace-http-csrf-token-32-characters";
  const origin = "http://127.0.0.1:5175";
  const config = {
    databasePath: join(directory, "runtime.sqlite"),
    actor,
    sessionToken,
    csrfToken,
    allowedOrigins: [origin],
    defaultAgentVersionId: "default-agent-v1",
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "workspace-test-key",
    desktopWorkspaceRegistryPath: registryPath,
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
  };
  let runtime = createStandaloneControlApi(config);
  context.after(async () => {
    await runtime.app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const headers = {
    "authorization": `Bearer ${sessionToken}`,
    origin,
    "x-csrf-token": csrfToken,
  };
  const create = async (workspaceId: string | null) =>
    runtime.app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: { ...headers, "idempotency-key": `create-${workspaceId}` },
      payload: { title: null, workspaceId },
    });
  const created = await create("workspace-a");
  assert.equal(created.statusCode, 201, created.body);
  const thread = created.json().thread;
  assert.equal(thread.workspaceId, "workspace-a");
  assert.equal((await create("workspace-unknown")).statusCode, 404);
  assert.equal((await create(null)).statusCode, 201);
  writeFileSync(
    registryPath,
    JSON.stringify({
      ...registry,
      revision: 2,
      activeWorkspaceId: "workspace-b",
    }),
  );
  await runtime.app.close();
  runtime = createStandaloneControlApi({
    ...config,
    artifactStore: new InMemoryArtifactStore(),
  });
  const reopened = await runtime.app.inject({
    method: "GET",
    url: `/api/v1/threads/${thread.threadId}`,
    headers,
  });
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.equal(reopened.json().thread.workspaceId, "workspace-a");
  const forked = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/threads/${thread.threadId}/forks`,
    headers: {
      ...headers,
      "idempotency-key": "fork-after-workspace-selection",
    },
    payload: {
      expectedRevision: thread.revision,
      throughHistorySequence: null,
    },
  });
  assert.equal(forked.statusCode, 201, forked.body);
  assert.equal(forked.json().thread.workspaceId, "workspace-a");
});

test("desktop registry configuration is explicit and forbidden in production", () => {
  assert.equal(
    resolveDesktopWorkspaceRegistryPath({}, "standalone"),
    undefined,
  );
  assert.equal(
    resolveDesktopWorkspaceRegistryPath(
      { [environmentName]: "/tmp/registry.json" },
      "standalone",
    ),
    "/tmp/registry.json",
  );
  for (const value of [
    "",
    "registry.json",
    " /tmp/registry.json",
    "/tmp/registry\0.json",
  ]) {
    assert.throws(
      () =>
        resolveDesktopWorkspaceRegistryPath(
          { [environmentName]: value },
          "standalone",
        ),
      /_invalid/,
    );
  }
  assert.throws(
    () =>
      resolveDesktopWorkspaceRegistryPath(
        { [environmentName]: "/does-not-exist" },
        "production",
      ),
    /_forbidden/,
  );
});

test("desktop admission uses current registry identities without changing actor scope", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-workspace-admission-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "registry.json");
  const registry = {
    schemaVersion: "crewon.desktop-workspace-authority.v2",
    revision: 1,
    activeWorkspaceId: "workspace-a",
    workspaces: [{ workspaceId: "workspace-a", root: "/private/a" }],
  };
  writeFileSync(path, JSON.stringify(registry));
  const admission = createDesktopWorkspaceAdmission(path, actor)!;
  await admission.admit({ actor, workspaceId: "workspace-a" });
  await assert.rejects(
    admission.admit({ actor, workspaceId: "workspace-b" }),
    /workspace_not_found/,
  );
  await assert.rejects(
    admission.admit({
      actor: { ...actor, spaceId: "other" },
      workspaceId: "workspace-a",
    }),
    /workspace_not_found/,
  );
  writeFileSync(
    path,
    JSON.stringify({
      ...registry,
      revision: 2,
      workspaces: [
        ...registry.workspaces,
        { workspaceId: "workspace-b", root: "/private/b" },
      ],
    }),
  );
  await admission.admit({ actor, workspaceId: "workspace-b" });
  for (const invalid of [
    { ...registry, schemaVersion: "crewon.desktop-workspace-authority.v1" },
    {
      ...registry,
      workspaces: [...registry.workspaces, ...registry.workspaces],
    },
    {
      ...registry,
      workspaces: Array.from({ length: 101 }, (_, index) => ({
        workspaceId: `workspace-${index}`,
        root: "/private",
      })),
    },
  ]) {
    writeFileSync(path, JSON.stringify(invalid));
    await assert.rejects(
      admission.admit({ actor, workspaceId: "workspace-a" }),
      /workspace_registry_unavailable/,
    );
  }
  writeFileSync(path, " ".repeat(128 * 1024 + 1));
  await assert.rejects(
    admission.admit({ actor, workspaceId: "workspace-a" }),
    /workspace_registry_unavailable/,
  );
});
