import {
  parsePluginControlPackageDigest,
  parsePluginSelectionListResponse,
  type PluginSelectionListQuery,
  type PluginSelectionView,
} from "./plugin-control-contract.ts";
import {
  copyPluginControlJson,
  pluginControlArray,
  pluginControlFail,
  pluginControlRecord,
  pluginControlRevision,
} from "./plugin-control-contract-support.ts";

export const PLUGIN_COMPOSITION_STATUS_SCHEMA =
  "crewon.plugin-composition-status.v1";
export const MAX_PLUGIN_COMPOSITION_STATUS_RESPONSE_BYTES = 64 * 1024;

/** A committed graph is metadata, never proof of a live Node instance. */
export type PluginCompositionMetadataStatus =
  | Readonly<{ state: "unobserved" }>
  | Readonly<{ state: "published"; lockDigest: string; revision: number }>
  | Readonly<{
      state: "failed";
      reasonCode:
        | "plugin_projection_pending"
        | "plugin_composition_metadata_unavailable";
    }>;

/** Node observation is separate from UI availability and does not grant invocation. */
export type PluginCompositionNodeStatus =
  | Readonly<{ state: "inactive" | "unobserved" | "preparing" | "ready" }>
  | Readonly<{
      state: "waitingDependency";
      reasonCode: "plugin_dependency_unavailable";
    }>
  | Readonly<{
      state: "failed";
      reasonCode:
        | "plugin_activation_failed"
        | "plugin_cleanup_failed"
        | "plugin_authority_unavailable"
        | "plugin_composition_unavailable";
    }>;

export type PluginCompositionStatusResponse = Readonly<{
  schemaVersion: typeof PLUGIN_COMPOSITION_STATUS_SCHEMA;
  metadata: PluginCompositionMetadataStatus;
  plugins: readonly Readonly<{
    selection: PluginSelectionView;
    node: PluginCompositionNodeStatus;
  }>[];
  next: string | null;
}>;

/** Exact versioned DTO; no private scope, paths, exception text or executable graph. */
export function parsePluginCompositionStatusResponse(
  input: unknown,
  context: PluginSelectionListQuery,
): PluginCompositionStatusResponse {
  const value = pluginControlRecord(
    copyPluginControlJson(input, {
      maxBytes: MAX_PLUGIN_COMPOSITION_STATUS_RESPONSE_BYTES,
    }),
    ["schemaVersion", "metadata", "plugins", "next"],
  );
  if (value.schemaVersion !== PLUGIN_COMPOSITION_STATUS_SCHEMA)
    pluginControlFail("plugin_composition_status_schema_unsupported");
  const entries = pluginControlArray(value.plugins, 50).map((entry) =>
    pluginControlRecord(entry, ["selection", "node"]),
  );
  const page = parsePluginSelectionListResponse(
    { selections: entries.map((entry) => entry.selection), next: value.next },
    context,
  );
  const plugins = page.selections.map((selection, index) => {
    const node = parseNode(entries[index]!.node);
    const inactiveCleanupFailure =
      node.state === "failed" && node.reasonCode === "plugin_cleanup_failed";
    if (
      (selection.state !== "enabled" &&
        node.state !== "inactive" &&
        !inactiveCleanupFailure) ||
      (selection.state === "enabled" && node.state === "inactive")
    )
      pluginControlFail("plugin_composition_status_selection_mismatch");
    return Object.freeze({ selection, node });
  });
  return Object.freeze({
    schemaVersion: PLUGIN_COMPOSITION_STATUS_SCHEMA,
    metadata: parseMetadata(value.metadata),
    plugins: Object.freeze(plugins),
    next: page.next,
  });
}

function parseMetadata(input: unknown): PluginCompositionMetadataStatus {
  const value = pluginControlRecord(
    input,
    ["state", "lockDigest", "revision", "reasonCode"],
    { optional: ["lockDigest", "revision", "reasonCode"] },
  );
  if (value.state === "unobserved") {
    pluginControlRecord(input, ["state"]);
    return Object.freeze({ state: "unobserved" });
  }
  if (value.state === "published") {
    pluginControlRecord(input, ["state", "lockDigest", "revision"]);
    return Object.freeze({
      state: "published",
      lockDigest: parsePluginControlPackageDigest(value.lockDigest),
      revision: pluginControlRevision(value.revision),
    });
  }
  if (
    value.state === "failed" &&
    (value.reasonCode === "plugin_projection_pending" ||
      value.reasonCode === "plugin_composition_metadata_unavailable")
  ) {
    pluginControlRecord(input, ["state", "reasonCode"]);
    return Object.freeze({ state: "failed", reasonCode: value.reasonCode });
  }
  return pluginControlFail("plugin_composition_status_metadata_invalid");
}

function parseNode(input: unknown): PluginCompositionNodeStatus {
  const value = pluginControlRecord(input, ["state", "reasonCode"], {
    optional: ["reasonCode"],
  });
  switch (value.state) {
    case "inactive":
    case "unobserved":
    case "preparing":
    case "ready":
      pluginControlRecord(input, ["state"]);
      return Object.freeze({ state: value.state });
    case "waitingDependency":
      if (value.reasonCode !== "plugin_dependency_unavailable")
        pluginControlFail("plugin_composition_status_node_invalid");
      return Object.freeze({
        state: "waitingDependency",
        reasonCode: "plugin_dependency_unavailable",
      });
    case "failed":
      switch (value.reasonCode) {
        case "plugin_activation_failed":
        case "plugin_cleanup_failed":
        case "plugin_authority_unavailable":
        case "plugin_composition_unavailable":
          return Object.freeze({
            state: "failed",
            reasonCode: value.reasonCode,
          });
      }
  }
  return pluginControlFail("plugin_composition_status_node_invalid");
}
