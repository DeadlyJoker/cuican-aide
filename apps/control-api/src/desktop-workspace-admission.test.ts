import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDesktopWorkspaceAdmission,
  resolveDesktopWorkspaceRegistryPath,
} from "./desktop-workspace-admission.ts";

const actor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};
const environmentName = "CREWON_DESKTOP_WORKSPACE_REGISTRY_PATH";

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
