import { createHash } from "node:crypto";
import {
  createPluginCompositionLock,
  parsePluginCompositionLock,
  type PluginCompositionHostService,
  type PluginCompositionLock,
  type PluginCompositionNode,
  type PluginCompositionScope,
} from "@crewon/contracts/plugins";
import {
  assertPluginProfileScope,
  assertPluginSelectionPackage,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
} from "@crewon/domain";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  SQLITE_PLUGIN_PROFILE_OWNER_LIMITS,
  type SqlitePluginInstallationProfileOwner,
} from "@crewon/store";
import {
  assertDesktopPluginSourceRegistry,
  type DesktopPluginSourceRegistry,
} from "./desktop-plugin-source-registry.ts";
import {
  installationSame,
  verifyDesktopInstalledPackage,
} from "./desktop-plugin-runtime-support.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
function fail(code: string): never {
  throw new Error(code);
}
function vector(input: unknown): readonly unknown[] {
  const max = SQLITE_PLUGIN_PROFILE_OWNER_LIMITS.selectionsPerProfile;
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > max ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    fail("desktop_plugin_node_projection_vector_invalid");
  return Object.freeze(
    Array.from({ length: input.length }, (_, index) => {
      const entry = Object.getOwnPropertyDescriptor(input, String(index));
      if (!entry || !entry.enumerable || !Object.hasOwn(entry, "value"))
        fail("desktop_plugin_node_projection_vector_invalid");
      return entry.value as unknown;
    }),
  );
}

export type DesktopPluginNodeCompositionProjection = Readonly<{
  /** Private execution planning only. Never persist this or substitute it for a Run's original graph. */
  privateLock: PluginCompositionLock;
  sourceLockDigest: string;
}>;

/** Verifies the full saved graph before excluding UI-only instances from Node execution planning.
 * The caller owns current durable head/claim/approval fences; a snapshot DTO is not an authority.
 * No package import, NodeHost creation, Store mutation or migration takes place here.
 */
export async function projectDesktopPluginNodeComposition(
  input: Readonly<{
    sourceLock: unknown;
    snapshot: ReturnType<SqlitePluginInstallationProfileOwner["snapshot"]>;
    scope: PluginCompositionScope;
    hostServices: readonly PluginCompositionHostService[];
    installRoot: string;
    registry: DesktopPluginSourceRegistry;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    signal: AbortSignal;
    /** Synchronous actual owner/head/claim/full-vector fence, including current Native approval. */
    assertCurrent(): void;
  }>,
): Promise<DesktopPluginNodeCompositionProjection> {
  const signal = input.signal;
  const assertCurrent = input.assertCurrent;
  if (!(signal instanceof AbortSignal) || typeof assertCurrent !== "function")
    fail("desktop_plugin_node_projection_fence_required");
  const check = () => {
    signal.throwIfAborted();
    assertCurrent.call(input);
    signal.throwIfAborted();
  };
  check();
  // Strict parsers copy every graph/vector field before the first asynchronous read.
  const source = parsePluginCompositionLock(input.sourceLock, digester);
  const expected = createPluginCompositionLock(
    {
      schemaVersion: source.schemaVersion,
      scope: input.scope,
      revision: source.revision,
      nodes: [],
      hostServices: input.hostServices,
    },
    digester,
  );
  if (!installationSame(source.scope, expected.scope))
    fail("desktop_plugin_node_projection_scope_conflict");
  if (!installationSame(source.hostServices, expected.hostServices))
    fail("desktop_plugin_node_projection_catalog_conflict");
  const raw = pluginSecurityRecord(input.snapshot, [
    "scope",
    "selections",
    "selectedPackages",
  ]);
  const scope = parsePluginProfileScope(raw.scope);
  assertPluginProfileScope(scope, {
    tenantId: source.scope.tenantId,
    spaceId: source.scope.spaceId,
    profileId: source.scope.profileId,
  });
  const selections = vector(raw.selections).map(parsePluginSelection);
  const packages = vector(raw.selectedPackages).map(
    parseInstalledPluginPackage,
  );
  const selected = new Map(selections.map((entry) => [entry.pluginId, entry]));
  const installed = new Map(
    packages.map((entry) => [entry.packageDigest, entry]),
  );
  if (selected.size !== selections.length || installed.size !== packages.length)
    fail("desktop_plugin_node_projection_vector_conflict");
  const referenced = new Set<string>();
  for (const selection of selections) {
    assertPluginProfileScope(scope, selection);
    const pkg =
      selection.selectedPackageDigest === null
        ? null
        : (installed.get(selection.selectedPackageDigest) ?? null);
    assertPluginSelectionPackage({ selection, package: pkg });
    if (pkg !== null) referenced.add(pkg.packageDigest);
  }
  for (const pkg of packages) assertPluginProfileScope(scope, pkg);
  if (referenced.size !== packages.length)
    fail("desktop_plugin_node_projection_vector_conflict");
  const enabled = selections.filter((entry) => entry.state === "enabled");
  if (enabled.length !== source.nodes.length)
    fail("desktop_plugin_node_projection_selection_conflict");
  for (const node of source.nodes) {
    const selection = selected.get(node.pluginId);
    const pkg = installed.get(node.packageDigest);
    if (
      !selection ||
      !pkg ||
      selection.state !== "enabled" ||
      selection.revision !== node.selectionRevision ||
      selection.publisherId !== node.publisherId ||
      selection.selectedPackageDigest !== node.packageDigest ||
      pkg.pluginId !== node.pluginId ||
      pkg.publisherId !== node.publisherId ||
      pkg.version !== node.version
    )
      fail("desktop_plugin_node_projection_selection_conflict");
  }
  const registry = input.registry;
  assertDesktopPluginSourceRegistry(registry);
  const installRoot = input.installRoot;
  const hostUiServices = capturePluginUiHostServiceAvailability(
    input.hostUiServices,
  );
  const verifiedNodes: PluginCompositionNode[] = [];
  const nodeIds = new Set<string>();
  for (const node of source.nodes) {
    check();
    const descriptor = await verifyDesktopInstalledPackage({
      installRoot,
      package: installed.get(node.packageDigest)!,
      registry,
      signal,
      hostUiServices,
    });
    check();
    verifiedNodes.push({
      pluginId: descriptor.pluginId,
      publisherId: descriptor.publisherId,
      version: descriptor.version,
      packageDigest: node.packageDigest,
      selectionRevision: node.selectionRevision,
      hostApi: descriptor.hostApi,
      requires: descriptor.requires,
      provides: descriptor.provides,
    });
    if (descriptor.entrypoints.node !== null) nodeIds.add(node.pluginId);
  }
  // Canonical reconstruction compares exact declarations and all derived bindings,
  // allowing harmless descriptor ordering while rejecting a forged stored graph.
  const verified = createPluginCompositionLock(
    {
      schemaVersion: source.schemaVersion,
      scope: source.scope,
      revision: source.revision,
      hostServices: source.hostServices,
      nodes: verifiedNodes,
    },
    digester,
  );
  if (verified.lockDigest !== source.lockDigest)
    fail("desktop_plugin_node_projection_descriptor_conflict");
  for (const edge of source.edges)
    if (
      nodeIds.has(edge.consumerPluginId) &&
      edge.provider.kind === "plugin" &&
      !nodeIds.has(edge.provider.pluginId)
    )
      fail("desktop_plugin_node_projection_ui_provider_unavailable");
  const privateLock = createPluginCompositionLock(
    {
      schemaVersion: source.schemaVersion,
      scope: source.scope,
      revision: source.revision,
      hostServices: source.hostServices,
      nodes: source.nodes.filter((node) => nodeIds.has(node.pluginId)),
    },
    digester,
  );
  if (
    !installationSame(
      privateLock.edges,
      source.edges.filter((edge) => nodeIds.has(edge.consumerPluginId)),
    )
  )
    fail("desktop_plugin_node_projection_binding_conflict");
  check();
  return Object.freeze({ privateLock, sourceLockDigest: source.lockDigest });
}
