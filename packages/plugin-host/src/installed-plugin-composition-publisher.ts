import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  ActorContext,
  PluginCompositionStore,
  PluginInstallationStore,
} from "@crewon/application";
import {
  assertPluginProfileScope,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
} from "@crewon/domain";
import {
  createPluginCompositionLock,
  parsePluginCompositionLock,
  PLUGIN_COMPOSITION_LOCK_SCHEMA,
  type PluginCompositionHostService,
  type PluginCompositionLock,
  type PluginCompositionNode,
  type PluginCompositionScope,
} from "@crewon/contracts/plugins";
import {
  pinDirectory,
  assertDirectoryPins,
} from "./local-plugin-package-files.ts";
import { verifyLocalPluginPackage } from "./local-plugin-package-verifier.ts";

export class InstalledPluginCompositionPublisherError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "InstalledPluginCompositionPublisherError";
  }
}
function fail(code: string): never {
  throw new InstalledPluginCompositionPublisherError(code);
}
const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};

/** Metadata only: no entry import, migration, activation, retry or selection mutation. */
export async function publishInstalledPluginComposition(
  input: Readonly<{
    scope: PluginCompositionScope;
    actor: ActorContext;
    installRoot: string;
    hostServices: readonly PluginCompositionHostService[];
    installations: PluginInstallationStore;
    compositions: PluginCompositionStore;
    signal: AbortSignal;
    /** Host policy must check current ownership/approval; package identity alone is not trust. */
    authorizeSnapshot(lock: PluginCompositionLock): Promise<"allow" | "deny">;
  }>,
) {
  // Capture host-owned scope/services before the first asynchronous boundary.
  const template = createPluginCompositionLock(
    {
      schemaVersion: PLUGIN_COMPOSITION_LOCK_SCHEMA,
      scope: input.scope,
      revision: 1,
      nodes: [],
      hostServices: input.hostServices,
    },
    digester,
  );
  const scope = parsePluginProfileScope({
    tenantId: template.scope.tenantId,
    spaceId: template.scope.spaceId,
    profileId: template.scope.profileId,
  });
  const actor = Object.freeze({ ...input.actor });
  if (
    actor.tenantId !== scope.tenantId ||
    actor.spaceId !== scope.spaceId ||
    typeof actor.actorId !== "string" ||
    typeof actor.principalId !== "string" ||
    !actor.actorId ||
    !actor.principalId
  )
    fail("plugin_composition_actor_conflict");
  const signal = input.signal;
  const installations = input.installations;
  const compositions = input.compositions;
  const authorize = input.authorizeSnapshot;
  if (typeof authorize !== "function")
    fail("plugin_composition_authority_missing");
  signal.throwIfAborted();
  const root = await pinDirectory(input.installRoot);
  if (
    (typeof process.getuid === "function" &&
      root.stats.uid !== BigInt(process.getuid())) ||
    (root.stats.mode & 0o022n) !== 0n
  )
    fail("plugin_composition_install_root_invalid");
  const rawHead = await compositions.loadCurrent({ scope });
  const head =
    rawHead === null ? null : parsePluginCompositionLock(rawHead, digester);
  if (head !== null)
    assertPluginProfileScope(scope, {
      tenantId: head.scope.tenantId,
      spaceId: head.scope.spaceId,
      profileId: head.scope.profileId,
    });
  const nodes: PluginCompositionNode[] = [];
  let afterPluginId: string | null = null;
  let scanned = 0;
  do {
    signal.throwIfAborted();
    const page = await installations.listSelections({
      scope,
      afterPluginId,
      limit: 50,
    });
    if (page.selections.length > 50)
      fail("plugin_composition_selection_page_invalid");
    for (const raw of page.selections) {
      const selection = parsePluginSelection(raw);
      assertPluginProfileScope(scope, selection);
      if (afterPluginId !== null && selection.pluginId <= afterPluginId)
        fail("plugin_composition_selection_page_invalid");
      afterPluginId = selection.pluginId;
      if (++scanned > 1024) fail("plugin_composition_selection_limit");
      if (selection.state !== "enabled") continue;
      if (nodes.length >= 64 || selection.selectedPackageDigest === null)
        fail("plugin_composition_node_limit");
      const rawPackage = await installations.loadPackage({
        scope,
        packageDigest: selection.selectedPackageDigest,
      });
      if (rawPackage === null) fail("plugin_composition_package_missing");
      const pkg = parseInstalledPluginPackage(rawPackage);
      assertPluginProfileScope(scope, pkg);
      if (
        pkg.pluginId !== selection.pluginId ||
        pkg.publisherId !== selection.publisherId ||
        pkg.packageDigest !== selection.selectedPackageDigest
      )
        fail("plugin_composition_package_conflict");
      signal.throwIfAborted();
      const directory = join(root.path, "packages", pkg.packageDigest.slice(7));
      const verified = await verifyLocalPluginPackage({ directory, signal });
      const descriptor = verified.descriptor;
      if (
        verified.directory !== directory ||
        verified.packageDigest !== pkg.packageDigest ||
        descriptor.pluginId !== pkg.pluginId ||
        descriptor.publisherId !== pkg.publisherId ||
        descriptor.version !== pkg.version
      )
        fail("plugin_composition_package_conflict");
      nodes.push({
        pluginId: pkg.pluginId,
        publisherId: pkg.publisherId,
        version: pkg.version,
        packageDigest: pkg.packageDigest,
        selectionRevision: selection.revision,
        hostApi: descriptor.hostApi,
        requires: descriptor.requires,
        provides: descriptor.provides,
      });
    }
    if (
      page.next !== null &&
      (page.selections.length === 0 || page.next !== afterPluginId)
    )
      fail("plugin_composition_selection_page_invalid");
    if (page.next === null) break;
  } while (true);
  const lock = createPluginCompositionLock(
    {
      schemaVersion: PLUGIN_COMPOSITION_LOCK_SCHEMA,
      scope: template.scope,
      revision: head === null ? 1 : head.revision + 1,
      nodes,
      hostServices: template.hostServices,
    },
    digester,
  );
  signal.throwIfAborted();
  if ((await authorize.call(input, lock)) !== "allow")
    fail("plugin_composition_snapshot_denied");
  signal.throwIfAborted();
  await assertDirectoryPins([root]);
  signal.throwIfAborted();
  // Always use a new revision. Existing receipt replay would bypass a fresh vector fence.
  // The original Store atomically checks every enabled package/revision and head CAS.
  const result = await compositions.commit({
    scope: template.scope,
    actor,
    lock,
    expectedRevision: head?.revision ?? null,
  });
  // A concurrent identical writer may cause receipt replay, which does not
  // rerun the Store's vector fence. Such a snapshot cannot authorize activation.
  if (result.disposition !== "committed")
    fail("plugin_composition_snapshot_superseded");
  return result;
}
