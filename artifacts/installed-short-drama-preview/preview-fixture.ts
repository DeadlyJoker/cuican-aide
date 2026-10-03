import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ApplicationError,
  PluginUiApplicationService,
  type ActorContext,
} from "../../packages/application/src/index.ts";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
} from "../../packages/domain/src/index.ts";
import {
  installLocalPluginPackage,
  LocalPluginUiPackageReader,
} from "../../packages/plugin-host/src/index.ts";
import { SqliteRunStore } from "../../packages/store/src/index.ts";
import type { PluginUiControlService } from "../../apps/control-api/src/plugin-control-route.ts";

export const actor: ActorContext = Object.freeze({
  tenantId: "installed-short-drama-preview-tenant",
  spaceId: "installed-short-drama-preview-space",
  principalId: "named-preview-principal-no-login",
  actorId: "named-preview-actor-no-login",
});
export const profile = Object.freeze({
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "installed-short-drama-preview-profile",
});

/** Explicit one-package local fixture, never a production publisher or authenticated user policy. */
export async function createInstalledShortDramaFixture(directory: string) {
  const ownedRoot = await mkdtemp(
    join(tmpdir(), "crewon-installed-short-drama-preview-"),
  );
  let store: SqliteRunStore | null = null;
  let inspection: DatabaseSync | null = null;
  let closed = false;
  const mounts = new Set<string>();
  let active = true;
  let assetsRead = 0;
  let deniedActions = 0;
  const epoch = "named-preview-policy-" + randomUUID();
  try {
    const installRoot = join(ownedRoot, "installed");
    await mkdir(installRoot, { mode: 0o700 });
    const installed = await installLocalPluginPackage({
      directory,
      installRoot,
      authorization: async (input) => {
        const descriptor = input.descriptor;
        return descriptor.pluginId === "crewon.short-drama" &&
          descriptor.publisherId === "example.publisher" &&
          descriptor.version === "1.0.0" &&
          descriptor.entrypoints.node === null &&
          descriptor.entrypoints.ui?.mode === "trustedModule" &&
          descriptor.businessManifestPath === null &&
          descriptor.requires.length === 0 &&
          descriptor.provides.length === 0 &&
          descriptor.contributions.length === 1 &&
          descriptor.contributions[0]?.id === "workbench"
          ? { outcome: "allow" as const }
          : {
              outcome: "deny" as const,
              reasonCode: "named_preview_package_not_approved",
            };
      },
    });
    const databasePath = join(ownedRoot, "preview.sqlite");
    store = new SqliteRunStore(databasePath);
    const ledger = store.pluginInstallationStore();
    await ledger.migrate();
    const timestamp = new Date().toISOString();
    const receipt = (key: string) => ({
      idempotencyKey: key,
      requestDigest: "sha256:" + createHash("sha256").update(key).digest("hex"),
    });
    const saved = await ledger.recordInstalledPackage({
      scope: profile,
      actor,
      receipt: receipt("named-preview-install-v1"),
      expectedSelectionRevision: null,
      package: parseInstalledPluginPackage({
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...profile,
        pluginId: installed.descriptor.pluginId,
        publisherId: installed.descriptor.publisherId,
        version: installed.descriptor.version,
        packageDigest: installed.packageDigest,
        installedAt: timestamp,
        installedByPrincipalId: actor.principalId,
        installedByActorId: actor.actorId,
      }),
    });
    const selected = await ledger.commitSelection({
      scope: profile,
      actor,
      receipt: receipt("named-preview-enable-v1"),
      expectedSelectionRevision: saved.selection.revision,
      selection: parsePluginSelection({
        ...saved.selection,
        revision: saved.selection.revision + 1,
        state: "enabled",
        updatedAt: timestamp,
        updatedByPrincipalId: actor.principalId,
        updatedByActorId: actor.actorId,
      }),
    });
    inspection = new DatabaseSync(databasePath, { readOnly: true });
    const reader = new LocalPluginUiPackageReader({
      profile,
      installRoot,
      authorizePublication: async (input) => {
        if (!active || input.package.packageDigest !== installed.packageDigest)
          throw new ApplicationError(
            "authorization",
            "named_preview_publication_denied",
          );
        return input.descriptor.files
          .filter(
            (file) =>
              file.path === "ui.mjs" ||
              /^assets\/[A-Za-z0-9_-]+\.png$/u.test(file.path),
          )
          .map((file) => file.path);
      },
    });
    const application = new PluginUiApplicationService({
      store: ledger,
      profiles: {
        resolve: async (current) => {
          if (
            !active ||
            current.tenantId !== actor.tenantId ||
            current.spaceId !== actor.spaceId ||
            current.principalId !== actor.principalId ||
            current.actorId !== actor.actorId
          )
            throw new ApplicationError(
              "authorization",
              "named_preview_actor_denied",
            );
          return profile;
        },
      },
      authorization: {
        authorize: async ({ action, resource }) => {
          if (action === "invoke") deniedActions += 1;
          return active &&
            action !== "invoke" &&
            resource.tenantId === profile.tenantId &&
            resource.spaceId === profile.spaceId &&
            resource.profileId === profile.profileId &&
            (resource.pluginId === null ||
              resource.pluginId === installed.descriptor.pluginId)
            ? { outcome: "allow" as const, authorityEpoch: epoch }
            : { outcome: "deny" as const, reasonCode: "named_preview_ui_only" };
        },
      },
      packages: {
        verify: (input) => reader.verify(input),
        readAsset: async (input) => {
          const result = await reader.readAsset(input);
          assetsRead += 1;
          return result;
        },
      },
      actions: {
        invoke: async () => {
          throw new ApplicationError(
            "authorization",
            "named_preview_has_no_actions",
          );
        },
      },
      ids: { nextId: () => randomBytes(32).toString("base64url") },
      clock: { now: () => new Date().toISOString() },
    });
    const service: PluginUiControlService = {
      catalog: (current, input) => application.catalog(current, input),
      validateMount: (current, input) =>
        application.validateMount(current, input),
      readAsset: (current, input) => application.readAsset(current, input),
      invoke: (current, input) => application.invoke(current, input),
      openMount: async (current, input) => {
        const lease = await application.openMount(current, input);
        mounts.add(lease.mountRef);
        return lease;
      },
      closeMount: async (current, input) => {
        await application.closeMount(current, input);
        mounts.delete(input.mountRef);
      },
    };
    return {
      actor,
      profile,
      ownedRoot,
      service,
      withdraw() {
        active = false;
      },
      proof() {
        if (!inspection || closed) throw new Error("named_preview_closed");
        const count = (name: string) =>
          Number(
            (
              inspection!
                .prepare(`SELECT COUNT(*) AS count FROM ${name}`)
                .get() as { count: number }
            ).count,
          );
        return {
          schemaVersion: "crewon.installed-short-drama-preview.v1",
          identityKind: "named-loopback-fixture-no-login",
          profile,
          pluginId: installed.descriptor.pluginId,
          version: installed.descriptor.version,
          packageDigest: installed.packageDigest,
          selectionRevision: selected.selection.revision,
          installedDirectory: installed.directory,
          activeMounts: mounts.size,
          assetsRead,
          deniedActions,
          runs: count("run_snapshots"),
          threads: count("threads"),
          messages: count("messages"),
          installedPackages: count("installed_plugin_packages"),
          selectionReceipts: count("plugin_installation_receipts"),
          creditTables: inspection
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plugin_credit_%'",
            )
            .all().length,
        };
      },
      async close() {
        if (closed) return;
        active = false;
        for (const mountRef of mounts) {
          try {
            await application.closeMount(actor, { mountRef });
          } catch (error) {
            if (
              !(error instanceof ApplicationError) ||
              error.category !== "notFound" ||
              error.code !== "plugin_ui_mount_unavailable"
            )
              throw error;
          }
        }
        mounts.clear();
        inspection?.close();
        inspection = null;
        await store!.close();
        store = null;
        await writableOwnedTree(ownedRoot);
        await rm(ownedRoot, { recursive: true, force: true });
        closed = true;
      },
    };
  } catch (error) {
    inspection?.close();
    await store?.close();
    await writableOwnedTree(ownedRoot);
    await rm(ownedRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writableOwnedTree(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink())
    throw new Error("named_preview_cleanup_link_refused");
  await chmod(path, entry.isDirectory() ? 0o700 : 0o600);
  if (entry.isDirectory())
    for (const name of await readdir(path))
      await writableOwnedTree(join(path, name));
}
