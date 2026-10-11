import { ApplicationError } from "@crewon/application";
import {
  PLUGIN_COMPOSITION_STATUS_SCHEMA,
  parsePluginCompositionStatusResponse,
  type PluginCompositionMetadataStatus,
  type PluginCompositionNodeStatus,
  type PluginCompositionStatusResponse,
  type PluginSelectionListQuery,
  type PluginSelectionView,
} from "@crewon/contracts";
import {
  assertPluginProfileScope,
  assertPluginSelectionPackage,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationVersion,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import type { PluginNodeHost } from "@crewon/plugin-host";
import type { SqlitePluginInstallationProfileOwner } from "@crewon/store";
import type { DesktopPluginCompositionMetadataState } from "./desktop-plugin-composition-metadata-owner.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export type DesktopPluginCompositionStatusObservation = Readonly<{
  scope: PluginProfileScope;
  query: PluginSelectionListQuery;
  page: Readonly<{
    selections: readonly PluginSelection[];
    next: string | null;
  }>;
  projection: ReturnType<SqlitePluginInstallationProfileOwner["snapshot"]>;
  metadata: DesktopPluginCompositionMetadataState;
  nodes: ReturnType<PluginNodeHost["snapshot"]>;
}>;
type NodeObservation =
  DesktopPluginCompositionStatusObservation["nodes"][number];

/**
 * Pure projection of one profile-owned observation. These records are not authority:
 * the caller must capture them in its original queue, between actual actor/scope,
 * authority-epoch and SQLite-claim checks. This function never activates or recovers.
 */
export function projectDesktopPluginCompositionStatus(
  input: DesktopPluginCompositionStatusObservation,
): PluginCompositionStatusResponse {
  try {
    return project(input);
  } catch (cause) {
    throw new ApplicationError(
      "internal",
      "plugin_composition_status_observation_invalid",
      {
        cause,
      },
    );
  }
}

function project(
  input: DesktopPluginCompositionStatusObservation,
): PluginCompositionStatusResponse {
  const value = pluginSecurityRecord(input, [
    "scope",
    "query",
    "page",
    "projection",
    "metadata",
    "nodes",
  ]);
  const scope = parsePluginProfileScope(value.scope);
  const rawQuery = pluginSecurityRecord(value.query, [
    "afterPluginId",
    "limit",
  ]);
  const query: PluginSelectionListQuery = Object.freeze({
    afterPluginId:
      rawQuery.afterPluginId === null
        ? null
        : pluginInstallationNamespaceId(rawQuery.afterPluginId),
    limit: boundedInteger(rawQuery.limit, 1, 50),
  });
  const projection = pluginSecurityRecord(value.projection, [
    "scope",
    "selections",
    "selectedPackages",
  ]);
  assertPluginProfileScope(scope, parsePluginProfileScope(projection.scope));
  const selections = boundedArray(projection.selections, 256).map(
    parsePluginSelection,
  );
  const packages = boundedArray(projection.selectedPackages, 256).map(
    parseInstalledPluginPackage,
  );
  const selectedPackages = new Map(packages.map((pkg) => [pkg.pluginId, pkg]));
  if (selectedPackages.size !== packages.length) invalid();
  let previous: string | null = null;
  for (const selection of selections) {
    assertPluginProfileScope(scope, selection);
    if (previous !== null && selection.pluginId <= previous) invalid();
    previous = selection.pluginId;
    assertPluginSelectionPackage({
      selection,
      package: selectedPackages.get(selection.pluginId) ?? null,
    });
  }
  if (
    packages.length !==
    selections.filter((selection) => selection.selectedPackageDigest !== null)
      .length
  )
    invalid();

  const page = pluginSecurityRecord(value.page, ["selections", "next"]);
  const pageSelections = boundedArray(page.selections, query.limit).map(
    parsePluginSelection,
  );
  const remaining = selections.filter(
    (selection) =>
      query.afterPluginId === null || selection.pluginId > query.afterPluginId,
  );
  const expected = remaining.slice(0, query.limit);
  const next =
    remaining.length > query.limit ? expected.at(-1)!.pluginId : null;
  if (
    page.next !== next ||
    JSON.stringify(pageSelections) !== JSON.stringify(expected)
  )
    invalid();

  const nodes = boundedArray(value.nodes, 256).map(parseNode);
  const accepting = new Set<string>();
  for (const node of nodes) {
    if (node.phase !== "accepting") continue;
    if (accepting.has(node.identity.pluginId)) invalid();
    accepting.add(node.identity.pluginId);
  }
  return parsePluginCompositionStatusResponse(
    {
      schemaVersion: PLUGIN_COMPOSITION_STATUS_SCHEMA,
      metadata: projectMetadata(value.metadata),
      plugins: expected.map((selection) => ({
        selection: selectionView(selection),
        node: projectNode(
          selection,
          selectedPackages.get(selection.pluginId)?.version ?? null,
          nodes,
        ),
      })),
      next,
    },
    query,
  );
}

function projectNode(
  selection: PluginSelection,
  version: string | null,
  nodes: readonly NodeObservation[],
): PluginCompositionNodeStatus {
  const samePlugin = nodes.filter(
    (node) => node.identity.pluginId === selection.pluginId,
  );
  if (selection.state !== "enabled") {
    // A durable disabled selection cannot prove withdrawal if admission is still live.
    if (samePlugin.some((node) => node.phase === "accepting")) invalid();
    return samePlugin.some((node) => node.phase === "cleanupFailed")
      ? { state: "failed", reasonCode: "plugin_cleanup_failed" }
      : { state: "inactive" };
  }
  const exact = samePlugin.filter(
    (node) =>
      node.identity.packageDigest === selection.selectedPackageDigest &&
      node.identity.version === version,
  );
  if (exact.some((node) => node.phase === "accepting"))
    return { state: "ready" };
  if (
    exact.some((node) => node.phase === "starting" || node.phase === "prepared")
  )
    return { state: "preparing" };
  if (exact.some((node) => node.phase === "cleanupFailed"))
    return { state: "failed", reasonCode: "plugin_cleanup_failed" };
  // A retained lease, a different digest, a UI-only selection and an empty cold
  // host are not proof of current Node readiness or of a dependency failure.
  return { state: "unobserved" };
}

function projectMetadata(input: unknown): PluginCompositionMetadataStatus {
  const outcome =
    input !== null && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "outcome")
      : undefined;
  if (!outcome || !Object.hasOwn(outcome, "value")) invalid();
  switch (outcome.value) {
    case "unknown":
      pluginSecurityRecord(input, ["outcome"]);
      return { state: "unobserved" };
    case "published": {
      const value = pluginSecurityRecord(input, [
        "outcome",
        "lockDigest",
        "revision",
      ]);
      return {
        state: "published",
        lockDigest: pluginInstallationDigest(value.lockDigest),
        revision: boundedInteger(value.revision, 1, Number.MAX_SAFE_INTEGER),
      };
    }
    case "unavailable": {
      const value = pluginSecurityRecord(input, ["outcome", "code"]);
      if (typeof value.code !== "string" || value.code.length > 128) invalid();
      return {
        state: "failed",
        reasonCode:
          value.code === "plugin_projection_pending"
            ? "plugin_projection_pending"
            : "plugin_composition_metadata_unavailable",
      };
    }
    default:
      return invalid();
  }
}

function parseNode(input: unknown): NodeObservation {
  const value = pluginSecurityRecord(input, ["identity", "phase", "borrowers"]);
  const identity = pluginSecurityRecord(value.identity, [
    "pluginId",
    "version",
    "packageDigest",
  ]);
  switch (value.phase) {
    case "starting":
    case "prepared":
    case "accepting":
    case "retained":
    case "disposing":
    case "disposed":
    case "cleanupFailed":
      return Object.freeze({
        identity: Object.freeze({
          pluginId: pluginInstallationNamespaceId(identity.pluginId),
          version: pluginInstallationVersion(identity.version),
          packageDigest: pluginInstallationDigest(identity.packageDigest),
        }),
        phase: value.phase,
        borrowers: boundedInteger(value.borrowers, 0, Number.MAX_SAFE_INTEGER),
      });
    default:
      return invalid();
  }
}

function selectionView(selection: PluginSelection): PluginSelectionView {
  const {
    pluginId,
    publisherId,
    revision,
    state,
    selectedPackageDigest,
    updatedAt,
  } = selection;
  return {
    pluginId,
    publisherId,
    revision,
    state,
    selectedPackageDigest,
    updatedAt,
  };
}

function boundedArray(input: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    input.length > maximum ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid();
  return Array.from({ length: input.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(input, String(index));
    if (!entry || !entry.enumerable || !Object.hasOwn(entry, "value"))
      invalid();
    return entry.value;
  });
}

function boundedInteger(
  input: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    invalid();
  return input;
}

function invalid(): never {
  throw new Error("plugin_composition_status_observation_invalid");
}
