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
import {
  ApplicationError,
  PluginInstallationApplicationService,
  type ActorContext,
  type PluginInstallationStore,
} from "@crewon/application";
import { parsePluginSelection } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import { LocalPluginInstallationHost } from "./plugin-installation-local-host.ts";
import {
  PluginNodeHost,
  type PluginActivationCandidate,
  type PluginNodeLease,
} from "./plugin-node-host.ts";
import { verifyLocalPluginPackage } from "./local-plugin-package-verifier.ts";
import type { PluginUiHostServiceAvailabilityPort } from "./plugin-ui-host-service-availability.ts";

export const actor: ActorContext = Object.freeze({
  tenantId: "tenant",
  spaceId: "space",
  principalId: "owner",
  actorId: "actor",
});
export const scope = Object.freeze({
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "local-profile",
});
export const timestamp = "2026-10-02T00:00:00.000Z";
export const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

/** Real local bytes, Node instances and SQLite; policies are explicit deterministic fixtures. */
export async function localInstallationFixture(
  t: TestContext,
  input: Readonly<{
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "crewon-plugin-ledger-host-"));
  await chmod(root, 0o700);
  const installRoot = join(root, "installed");
  await mkdir(installRoot, { mode: 0o700 });
  const databasePath = join(root, "control.sqlite");
  const parent = new SqliteRunStore(databasePath);
  const ledger = parent.pluginInstallationStore();
  await ledger.migrate();
  const observer = new DatabaseSync(databasePath);
  const sources = new Map<string, string>();
  const events: string[] = [];
  const leases = new Set<PluginNodeLease>();
  const nodeHost = new PluginNodeHost({
    services: [
      {
        service: "host.recorder",
        apiVersion: "1",
        value: { add: (value: string) => events.push(value) },
      },
    ],
  });
  const policy = {
    denyInstall: false,
    denyActivation: false,
    incompatible: false,
    denyCommit: false,
    beforeFence: null as (() => void) | null,
    activation: null as (() => Promise<void>) | null,
    compatibility: null as (() => Promise<void>) | null,
    activationCandidates: [] as PluginActivationCandidate[],
    compatibilityDescriptors: [] as (PluginPackageDescriptor | null)[],
  };
  const local = new LocalPluginInstallationHost({
    profile: scope,
    installRoot,
    nodeHost,
    hostUiServices: input.hostUiServices,
    resolveSource: async ({ sourceId, actor: who }) => {
      if (who.principalId !== actor.principalId || !sources.has(sourceId))
        throw new ApplicationError("notFound", "fixture_source_unknown");
      return sources.get(sourceId)!;
    },
    authorizeInstallation: async () => (policy.denyInstall ? "deny" : "allow"),
    authorizeActivation: async ({ candidate }) => {
      policy.activationCandidates.push(candidate);
      await policy.activation?.();
      return policy.denyActivation ? "deny" : "allow";
    },
    validateCompatibility: async ({ descriptor }) => {
      policy.compatibilityDescriptors.push(descriptor);
      await policy.compatibility?.();
      if (policy.incompatible)
        throw new ApplicationError(
          "conflict",
          "fixture_data_schema_incompatible",
        );
    },
    authorizeCommit: ({ selection }) => {
      policy.beforeFence?.();
      if (policy.denyCommit) return "deny";
      const row = observer
        .prepare(
          "SELECT record_json FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=?",
        )
        .get(
          scope.tenantId,
          scope.spaceId,
          scope.profileId,
          selection.pluginId,
        );
      return row &&
        JSON.stringify(
          parsePluginSelection(JSON.parse(String(row.record_json))),
        ) === JSON.stringify(selection)
        ? "allow"
        : "deny";
    },
  });
  const service = (store: PluginInstallationStore = ledger) =>
    new PluginInstallationApplicationService({
      store,
      profiles: { resolve: async () => scope },
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      host: local,
      clock: { now: () => timestamp },
      digester,
    });
  const app = service();
  t.after(async () => {
    for (const lease of leases) lease.release();
    try {
      await local.drain();
    } finally {
      try {
        await nodeHost.close();
      } finally {
        observer.close();
        await parent.close();
        await removeOwnedTree(root);
      }
    }
  });
  async function packageSource(
    version: string,
    options: {
      failSetup?: boolean;
      entryKind?: "node" | "mixed" | "uiOnly";
      requires?: PluginPackageDescriptor["requires"];
      provides?: PluginPackageDescriptor["provides"];
    } = {},
  ) {
    const sourceId = `source-${version}`;
    const directory = join(root, sourceId);
    const marker = join(root, `${sourceId}.imported`);
    const uiMarker = join(root, `${sourceId}.ui-imported`);
    const entryKind = options.entryKind ?? "node";
    await mkdir(directory, { mode: 0o700 });
    const source = `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)},'imported');
export default {apiVersion:'crewon.plugin-host.v1',pluginId:'example.story',setup(ctx){
 const recorder=ctx.services.get('host.recorder','1'); recorder.add('setup:${version}');
 ctx.onDispose(()=>recorder.add('dispose:${version}'));
 ctx.services.provide('example.story','1',{read:()=>${JSON.stringify(version)}});
 ${options.failSetup ? "throw new Error('fixture_setup_failed');" : ""}
}};`;
    const bytes = Buffer.from(source);
    const files = [];
    if (entryKind !== "uiOnly") {
      await writeFile(join(directory, "entry.mjs"), bytes);
      files.push({
        path: "entry.mjs",
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    if (entryKind !== "node") {
      const ui = Buffer.from(
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(uiMarker)},'ui imported');export default {};`,
      );
      await writeFile(join(directory, "ui.mjs"), ui);
      files.push({
        path: "ui.mjs",
        byteLength: ui.length,
        sha256: createHash("sha256").update(ui).digest("hex"),
      });
    }
    await writeFile(
      join(directory, "crewon.plugin.json"),
      JSON.stringify({
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId: "example.story",
        version,
        title: "Fixture story",
        description:
          "Deterministic local lifecycle fixture; no supplier or price.",
        publisherId: "example.publisher",
        entrypoints: {
          node: entryKind === "uiOnly" ? null : "entry.mjs",
          ui:
            entryKind === "node"
              ? null
              : { path: "ui.mjs", mode: "trustedModule" },
        },
        businessManifestPath: null,
        requires:
          options.requires ??
          (entryKind === "uiOnly"
            ? []
            : [{ service: "host.recorder", apiVersion: "1", optional: false }]),
        provides:
          options.provides ??
          (entryKind === "uiOnly"
            ? []
            : [{ service: "example.story", apiVersion: "1" }]),
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
    const verified = await verifyLocalPluginPackage({ directory });
    sources.set(sourceId, directory);
    return {
      sourceId,
      directory,
      marker,
      uiMarker,
      expectedPluginId: "example.story",
      expectedPackageDigest: verified.packageDigest,
    };
  }
  const current = () =>
    ledger.loadSelection({ scope, pluginId: "example.story" });
  const acquire = (digest: string) => {
    const lease = nodeHost.acquire({
      pluginId: "example.story",
      packageDigest: digest,
      purpose: "newOperation",
      authorizeBorrow: () => {
        const row = observer
          .prepare(
            "SELECT record_json FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=?",
          )
          .get(scope.tenantId, scope.spaceId, scope.profileId, "example.story");
        if (!row) return "deny";
        const selection = parsePluginSelection(
          JSON.parse(String(row.record_json)),
        );
        return selection.state === "enabled" &&
          selection.selectedPackageDigest === digest
          ? "allow"
          : "deny";
      },
    });
    leases.add(lease);
    return lease;
  };
  const read = (lease: PluginNodeLease) =>
    lease.getService<{ read(): string }>("example.story", "1").read();
  const select = (
    digest: string | null,
    revision: number,
    state: "enabled" | "disabled" | "uninstalled",
    key: string,
  ) =>
    app.select(actor, {
      pluginId: "example.story",
      state,
      selectedPackageDigest: digest,
      expectedSelectionRevision: revision,
      idempotencyKey: key,
    });
  const install = (
    pkg: Awaited<ReturnType<typeof packageSource>>,
    revision: number | null,
    key: string,
  ) =>
    app.install(actor, {
      sourceId: pkg.sourceId,
      expectedPluginId: pkg.expectedPluginId,
      expectedPackageDigest: pkg.expectedPackageDigest,
      expectedSelectionRevision: revision,
      idempotencyKey: key,
    });
  return {
    root,
    installRoot,
    databasePath,
    parent,
    ledger,
    observer,
    nodeHost,
    local,
    policy,
    app,
    service,
    events,
    packageSource,
    current,
    acquire,
    read,
    select,
    install,
  };
}

async function removeOwnedTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeOwnedTree(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
