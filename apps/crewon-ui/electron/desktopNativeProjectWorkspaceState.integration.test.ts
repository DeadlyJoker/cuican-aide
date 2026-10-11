import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqliteRunStore } from "@crewon/store";
import { captureDesktopNativePluginAuthorityOwner } from "./desktopNativePluginAuthority.ts";
import {
  captureDesktopNativeProjectWorkspaceState as capture,
  qualifyDesktopNativeProjectWorkspaceState as qualify,
} from "./desktopNativeProjectWorkspaceState.ts";
import { nativeProjectWorkspaceBridgeFixture } from "./desktopNativeProjectWorkspaceBridge.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { creationRecipe } from "../../../packages/store/src/creative-project-store.test-support.ts";
import { migrateSqlitePluginProjectMetadataOwners } from "../../../packages/store/src/plugin-project-metadata-owner-schema.ts";
import { pluginProjectMetadataOwnerColumns as columns } from "../../../packages/store/src/plugin-project-metadata-owner-records.ts";

const fixtures: Awaited<
  ReturnType<typeof nativeProjectWorkspaceBridgeFixture>
>[] = [];
const observation = vi.hoisted(() => ({
  afterRegistryRename: null as (() => void) | null,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      fs.renameSync(...args);
      if (String(args[1]).endsWith("/desktop-workspace.json")) {
        const callback = observation.afterRegistryRename;
        observation.afterRegistryRename = null;
        callback?.();
      }
    },
  };
});
afterEach(async () => {
  observation.afterRegistryRename = null;
  for (const f of fixtures.splice(0)) await f.close();
});

it("a project archived after actual Native registry commit is not published as successful allocation and its directory is preserved", async () => {
  const f = await fixture(),
    bridge = f.bridge();
  const ticket = bridge.prepareForProject(capture(f.input));
  observation.afterRegistryRename = () => {
    const db = new DatabaseSync(f.path);
    try {
      db.prepare(
        "UPDATE creative_projects SET state='archived',record_json=json_set(record_json,'$.state','archived') WHERE project_id=?",
      ).run(f.projectId);
    } finally {
      db.close();
    }
  };
  const result = await f.send(f.control, f.request(ticket));
  expect(result).toMatchObject({
    outcome: "unavailable",
    reasonCode: "allocation_unavailable",
  });
  expect(f.workspaces.status().workspaces).toHaveLength(2);
  expect(f.workspaces.root()).toBe(f.ordinary);
});
async function fixture(mismatch: "matching" | "plugin" = "matching") {
  const f = await nativeProjectWorkspaceBridgeFixture();
  fixtures.push(f);
  const pin = captureDesktopNativePluginAuthorityOwner(f.native);
  const parent = new SqliteRunStore(pin.authority.controlDatabasePath);
  const installed = parent.pluginInstallationStore();
  await installed.migrate();
  await parent.creativeProjectStore().migrate();
  const at = "2026-10-12T00:00:00.000Z",
    projectId = "main-owned-project";
  const pkg = await installed.recordInstalledPackage(
    installationRecipe("main-state-install", {
      actor: pin.authority.actor,
      scope: pin.authority.scope,
      ...f.packageIdentity,
    }),
  );
  await installed.commitSelection(
    selectionRecipe(pkg.selection, "main-state-enable", {
      actor: pin.authority.actor,
    }),
  );
  await parent
    .creativeProjectStore()
    .commitProjectCreation(
      creationRecipe(projectId, "main-state-project", pin.authority.actor, at),
    );
  const db = new DatabaseSync(pin.authority.controlDatabasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    migrateSqlitePluginProjectMetadataOwners(db);
    const owner = {
      ...pin.authority.actor,
      profileId: pin.authority.scope.profileId,
      pluginId:
        mismatch === "matching" ? f.packageIdentity.pluginId : "foreign.plugin",
      publisherId: f.packageIdentity.publisherId,
      projectId,
    };
    db.prepare(
      `INSERT INTO plugin_project_metadata_owners(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    ).run(
      owner.tenantId,
      owner.spaceId,
      owner.principalId,
      owner.actorId,
      owner.profileId,
      owner.pluginId,
      owner.publisherId,
      owner.projectId,
      at,
      JSON.stringify({
        schemaVersion: "crewon.plugin-project-metadata-owner.v1",
        owner,
        createdAt: at,
      }),
    );
    db.exec("COMMIT");
  } finally {
    db.close();
    parent.close();
  }
  return {
    ...f,
    projectId,
    input: {
      nativeAuthority: f.native,
      projectId,
      packageIdentity: f.packageIdentity,
    },
    path: pin.authority.controlDatabasePath,
  };
}
it("actual Main rechecks original protected project state before issuing and consuming the real child ticket", async () => {
  const f = await fixture();
  const ref = capture(f.input);
  expect(() => qualify({ ...ref })).toThrow("state_unavailable");
  const bridge = f.bridge();
  const ticket = bridge.prepareForProject(ref);
  const result = await f.send(f.control, f.request(ticket));
  expect(result?.outcome).toBe("observed");
  expect(f.workspaces.root()).toBe(f.ordinary);
  expect(f.workspaces.status().workspaces).toHaveLength(2);
});
it("actual Main refuses another plugin's persisted project without allocating a directory", async () => {
  const f = await fixture("plugin");
  expect(() => capture(f.input)).toThrow("metadata_owner_conflict");
  expect(f.workspaces.root()).toBe(f.ordinary);
  expect(f.workspaces.status().workspaces).toHaveLength(1);
});
it("archiving after ticket preparation rejects the actual child request before Native allocation", async () => {
  const f = await fixture(),
    bridge = f.bridge();
  const ticket = bridge.prepareForProject(capture(f.input));
  const db = new DatabaseSync(f.path);
  try {
    db.prepare(
      "UPDATE creative_projects SET state='archived',record_json=json_set(record_json,'$.state','archived') WHERE project_id=?",
    ).run(f.projectId);
  } finally {
    db.close();
  }
  const result = await f.send(f.control, f.request(ticket));
  expect(result).toMatchObject({
    outcome: "unavailable",
    reasonCode: "allocation_unavailable",
  });
  expect(f.workspaces.root()).toBe(f.ordinary);
  expect(f.workspaces.status().workspaces).toHaveLength(1);
});

it("selection revision changes invalidate a captured Main project state even when the same package is enabled again", async () => {
  const f = await fixture();
  const ref = capture(f.input);
  const parent = new SqliteRunStore(f.path);
  try {
    const installs = parent.pluginInstallationStore(),
      pin = captureDesktopNativePluginAuthorityOwner(f.native);
    const current = (await installs.loadSelection({
      scope: pin.authority.scope,
      pluginId: f.packageIdentity.pluginId,
    }))!;
    const disabled = await installs.commitSelection(
      selectionRecipe(current, "main-state-disable", {
        actor: pin.authority.actor,
        state: "disabled",
      }),
    );
    await installs.commitSelection(
      selectionRecipe(disabled.selection, "main-state-enable-again", {
        actor: pin.authority.actor,
      }),
    );
  } finally {
    parent.close();
  }
  expect(() => qualify(ref)).toThrow("state_unavailable");
  expect(f.workspaces.status().workspaces).toHaveLength(1);
});
