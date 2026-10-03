import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { ApplicationError, type ActorContext } from "@crewon/application";
import {
  parsePluginSelection,
  type PluginProfileScope,
  type InstalledPluginPackage,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { LocalPluginInstallationHost } from "./plugin-installation-local-host.ts";
import { PluginNodeHost, type PluginNodeLease } from "./plugin-node-host.ts";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";
import type {
  PluginInstalledSelectionRecoveryInput,
  PluginInstalledSelectionRecoveryPolicy,
} from "./plugin-installation-recovery.ts";
import type { PluginUiHostServiceAvailabilityPort } from "./plugin-ui-host-service-availability.ts";

export const recoveryActor: ActorContext = Object.freeze({
  tenantId: "tenant",
  spaceId: "space",
  principalId: "current-owner",
  actorId: "startup-host",
});
export const recoveryProfile: PluginProfileScope = Object.freeze({
  tenantId: "tenant",
  spaceId: "space",
  profileId: "profile-a",
});
const now = "2026-10-03T01:00:00.000Z";
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** Actual SQLite + installed files + native ESM. All permission decisions are explicit test policies. */
export async function installedRecoveryFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crewon-installed-recovery-"));
  await chmod(root, 0o700);
  const installRoot = join(root, "installed");
  await mkdir(installRoot, { mode: 0o700 });
  const databasePath = join(root, "control.sqlite");
  let parent = new SqliteRunStore(databasePath);
  let ledger = parent.pluginInstallationStore();
  await ledger.migrate();
  const observer = new DatabaseSync(databasePath);
  let sequence = 0;
  const hosts: PluginNodeHost[] = [];
  const leases = new Set<PluginNodeLease>();
  const events: string[] = [];
  const current = (scope: PluginProfileScope, pluginId: string) => {
    const row = observer
      .prepare(
        "SELECT record_json FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=?",
      )
      .get(scope.tenantId, scope.spaceId, scope.profileId, pluginId);
    return row
      ? parsePluginSelection(JSON.parse(String(row.record_json)))
      : null;
  };
  const dump = () =>
    [
      ["installed_plugin_packages", "record_json"],
      ["plugin_profile_selections", "record_json"],
      ["plugin_installation_receipts", "result_json"],
    ].map(([table, column]) =>
      observer
        .prepare(`SELECT ${column} FROM ${table} ORDER BY ${column}`)
        .all()
        .map((row) => row[column!]),
    );
  const receipt = () => ({
    idempotencyKey: `fixture-${++sequence}`,
    requestDigest: `sha256:${digest(`fixture-${sequence}`)}`,
  });

  async function packageSource(
    input: {
      pluginId?: string;
      version?: string;
      failSetup?: boolean;
      pauseSetup?: boolean;
      entryKind?: "node" | "mixed" | "uiOnly";
      provides?: readonly { service: string; apiVersion: string }[];
      requires?: readonly {
        service: string;
        apiVersion: string;
        optional: boolean;
      }[];
    } = {},
  ) {
    const pluginId = input.pluginId ?? "example.story";
    const version = input.version ?? "1.0.0";
    const id = `${pluginId}-${version}-${++sequence}`;
    const directory = join(root, id);
    const marker = join(root, `${id}.imported`);
    const uiMarker = join(root, `${id}.ui-imported`);
    const entryKind = input.entryKind ?? "node";
    await mkdir(directory, { mode: 0o700 });
    const provides =
      input.provides ??
      (entryKind === "uiOnly" ? [] : [{ service: pluginId, apiVersion: "1" }]);
    const requires =
      input.requires ??
      (entryKind === "uiOnly"
        ? []
        : [{ service: "host.recorder", apiVersion: "1", optional: false }]);
    const bytes = Buffer.from(`import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)},'imported');
export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(pluginId)},async setup(ctx){
 const recorder=ctx.services.get('host.recorder','1');recorder.add(${JSON.stringify(`setup:${pluginId}:${version}`)});
 ctx.onDispose(()=>recorder.add(${JSON.stringify(`dispose:${pluginId}:${version}`)}));
 ${input.pauseSetup ? "await recorder.pause();" : ""}
 ${requires
   .filter((r) => r.service !== "host.recorder" && !r.optional)
   .map(
     (r) =>
       `ctx.services.get(${JSON.stringify(r.service)},${JSON.stringify(r.apiVersion)});`,
   )
   .join("\n")}
 ${provides.map((p) => `ctx.services.provide(${JSON.stringify(p.service)},${JSON.stringify(p.apiVersion)},{read:()=>${JSON.stringify(`${pluginId}:${version}`)}});`).join("\n")}
 ${input.failSetup ? "throw new Error('fixture_setup_failed');" : ""}
}};`);
    const files = [];
    if (entryKind !== "uiOnly") {
      await writeFile(join(directory, "entry.mjs"), bytes);
      files.push({
        path: "entry.mjs",
        byteLength: bytes.length,
        sha256: digest(bytes),
      });
    }
    if (entryKind !== "node") {
      const ui = Buffer.from(
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(uiMarker)},'ui imported');export default {};`,
      );
      await writeFile(join(directory, "ui.mjs"), ui);
      files.push({ path: "ui.mjs", byteLength: ui.length, sha256: digest(ui) });
    }
    await writeFile(
      join(directory, "crewon.plugin.json"),
      JSON.stringify({
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId,
        version,
        title: "Recovery fixture",
        description: "Test-only recovery package; no supplier policy.",
        publisherId: "example.publisher",
        entrypoints: {
          node: entryKind === "uiOnly" ? null : "entry.mjs",
          ui:
            entryKind === "node"
              ? null
              : { path: "ui.mjs", mode: "trustedModule" },
        },
        businessManifestPath: null,
        requires,
        provides,
        contributions:
          entryKind === "node"
            ? []
            : [
                {
                  id: "story",
                  kind: "module",
                  slot: "main.content",
                  title: "Story",
                },
              ],
        files,
      }),
    );
    const installed = await installLocalPluginPackage({
      directory,
      installRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    await rm(directory, { recursive: true });
    return { installed, directory, marker, uiMarker };
  }

  async function save(
    pkg: Awaited<ReturnType<typeof packageSource>>,
    scope = recoveryProfile,
    state: "enabled" | "disabled" = "enabled",
  ) {
    const descriptor = pkg.installed.descriptor;
    const storedPackage: InstalledPluginPackage = {
      schemaVersion: "crewon.installed-plugin-package.v1",
      ...scope,
      pluginId: descriptor.pluginId,
      version: descriptor.version,
      publisherId: descriptor.publisherId,
      packageDigest: pkg.installed.packageDigest,
      installedAt: now,
      installedByPrincipalId: recoveryActor.principalId,
      installedByActorId: recoveryActor.actorId,
    };
    const before = current(scope, descriptor.pluginId);
    const installed = await ledger.recordInstalledPackage({
      scope,
      actor: recoveryActor,
      receipt: receipt(),
      package: storedPackage,
      expectedSelectionRevision: before?.revision ?? null,
    });
    if (state === "disabled") return installed.selection;
    return (
      await ledger.commitSelection({
        scope,
        actor: recoveryActor,
        receipt: receipt(),
        expectedSelectionRevision: installed.selection.revision,
        selection: {
          ...installed.selection,
          state,
          selectedPackageDigest: storedPackage.packageDigest,
          revision: installed.selection.revision + 1,
          updatedAt: now,
          updatedByPrincipalId: recoveryActor.principalId,
          updatedByActorId: recoveryActor.actorId,
        },
      })
    ).selection;
  }

  async function selectionInput(
    pluginId = "example.story",
    scope = recoveryProfile,
  ): Promise<PluginInstalledSelectionRecoveryInput> {
    const selection = await ledger.loadSelection({ scope, pluginId });
    if (!selection) throw new Error("fixture_selection_missing");
    return {
      actor: recoveryActor,
      scope,
      selection,
      package: selection.selectedPackageDigest
        ? await ledger.loadPackage({
            scope,
            packageDigest: selection.selectedPackageDigest,
          })
        : null,
    };
  }

  function host(
    profile = recoveryProfile,
    input: Readonly<{
      hostUiServices?: PluginUiHostServiceAvailabilityPort;
    }> = {},
  ) {
    const policy = {
      denyCurrent: false,
      denyActivation: false,
      denyCommit: false,
      incompatible: false,
      compatibility: null as (() => Promise<void>) | null,
      activation: null as (() => Promise<void>) | null,
      beforeCommit: null as (() => void) | null,
      selectionCompatibilityCalls: 0,
      pause: null as (() => Promise<void>) | null,
      checkedActors: [] as string[],
    };
    const node = new PluginNodeHost({
      services: [
        {
          service: "host.recorder",
          apiVersion: "1",
          value: {
            add: (event: string) =>
              events.push(`${profile.profileId}:${event}`),
            pause: () => policy.pause?.() ?? Promise.resolve(),
          },
        },
      ],
    });
    hosts.push(node);
    const local = new LocalPluginInstallationHost({
      profile,
      installRoot,
      nodeHost: node,
      hostUiServices: input.hostUiServices,
      resolveSource: async () => {
        throw new Error("recovery_must_not_resolve_source");
      },
      authorizeInstallation: async () => "deny",
      authorizeActivation: async () => {
        await policy.activation?.();
        return policy.denyActivation ? "deny" : "allow";
      },
      validateCompatibility: async () => {
        policy.selectionCompatibilityCalls++;
        if (policy.incompatible)
          throw new ApplicationError("conflict", "fixture_incompatible");
      },
      authorizeCommit: ({ selection, candidate }) => {
        policy.beforeCommit?.();
        if (
          policy.denyCommit ||
          JSON.stringify(current(profile, selection.pluginId)) !==
            JSON.stringify(selection)
        )
          return "deny";
        for (const dependency of candidate?.dependencyIdentities ?? []) {
          if (!dependency.provider) continue;
          const provider = current(profile, dependency.provider.pluginId);
          if (
            provider?.state !== "enabled" ||
            provider.selectedPackageDigest !== dependency.provider.packageDigest
          )
            return "deny";
        }
        return "allow";
      },
    });
    const authority: PluginInstalledSelectionRecoveryPolicy = {
      authorizeCurrent: (input) => {
        policy.checkedActors.push(input.actor.principalId);
        return !policy.denyCurrent &&
          JSON.stringify(current(profile, input.selection.pluginId)) ===
            JSON.stringify(input.selection)
          ? "allow"
          : "deny";
      },
      validateCompatibility: async () => {
        await policy.compatibility?.();
        if (policy.incompatible)
          throw new ApplicationError("conflict", "fixture_incompatible");
      },
    };
    const acquire = (input: PluginInstalledSelectionRecoveryInput) => {
      const lease = node.acquire({
        pluginId: input.selection.pluginId,
        packageDigest: input.selection.selectedPackageDigest!,
        purpose: "newOperation",
        authorizeBorrow: () => {
          const selection = current(profile, input.selection.pluginId);
          return !policy.denyCurrent &&
            selection?.state === "enabled" &&
            selection.selectedPackageDigest ===
              input.selection.selectedPackageDigest
            ? "allow"
            : "deny";
        },
      });
      leases.add(lease);
      return lease;
    };
    return { node, local, policy, authority, acquire };
  }

  const transition = async (
    pluginId: string,
    state: "enabled" | "disabled" | "uninstalled",
    packageDigest?: string | null,
    scope = recoveryProfile,
  ) => {
    const selection = current(scope, pluginId)!;
    return (
      await ledger.commitSelection({
        scope,
        actor: recoveryActor,
        receipt: receipt(),
        expectedSelectionRevision: selection.revision,
        selection: {
          ...selection,
          state,
          revision: selection.revision + 1,
          selectedPackageDigest:
            packageDigest === undefined
              ? selection.selectedPackageDigest
              : packageDigest,
        },
      })
    ).selection;
  };
  async function reopen() {
    await parent.close();
    parent = new SqliteRunStore(databasePath);
    ledger = parent.pluginInstallationStore();
  }
  t.after(async () => {
    for (const lease of leases) lease.release();
    try {
      for (const node of hosts) await node.close();
    } finally {
      observer.close();
      await parent.close();
      await removeTree(root);
    }
  });
  return {
    root,
    installRoot,
    databasePath,
    events,
    observer,
    packageSource,
    save,
    selectionInput,
    host,
    current,
    dump,
    transition,
    reopen,
  };
}

async function removeTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeTree(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
