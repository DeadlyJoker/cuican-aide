import {
  PLUGIN_UI_MAX_MOUNTS,
  PLUGIN_UI_MAX_TTL_MS,
  PLUGIN_UI_MAX_ASSET_BYTES,
  uiOutput,
  uiRecord,
  uiLimit,
} from "./plugin-ui-application-support.ts";
import type { ApplicationClock } from "./application-runtime-ports.ts";
import type { PluginInstallationHostProfilePort } from "./plugin-installation-host-port.ts";
import type { PluginInstallationStore } from "./plugin-installation-store-port.ts";
import type { PluginUiRecoveryPort } from "./plugin-ui-recovery-ports.ts";
import type { PluginProjectSourceUploadActionOwner } from "./plugin-project-source-upload-action-owner.ts";
import type {
  PluginUiActionPort,
  PluginUiCommittedTaskPort,
  PluginUiCommittedMetadataPort,
  PluginUiAuthorizationPort,
  PluginUiOpaqueIdPort,
  PluginUiPackagePort,
} from "./plugin-ui-ports.ts";
export type PluginUiApplicationLimits = Readonly<{
  mounts: number;
  ttlMs: number;
  assetBytes: number;
}>;
export type PluginUiApplicationDependencies = Readonly<{
  store: PluginInstallationStore;
  profiles: PluginInstallationHostProfilePort;
  authorization: PluginUiAuthorizationPort;
  packages: PluginUiPackagePort;
  actions: PluginUiActionPort;
  /** Genuine owner of the independent raw upload channel; missing leaves raw transport unavailable. */
  sourceUploads?: PluginProjectSourceUploadActionOwner;
  /** Trusted host receipt authority only; never supplied by a plugin or inferred from its JSON. */
  committedTasks?: PluginUiCommittedTaskPort;
  /** Separate trusted metadata receipt owner; does not authorize task/Run admission. */
  committedMetadata?: PluginUiCommittedMetadataPort;
  /** Explicit durable request staging; absent for existing packages and deployments. */
  recovery?: PluginUiRecoveryPort;
  ids: PluginUiOpaqueIdPort;
  clock: ApplicationClock;
  /** Only lower limits are accepted; there is no unbounded lease or byte configuration. */
  limits?: PluginUiApplicationLimits;
}>;

export function capturePluginUiApplicationLimits(
  input: PluginUiApplicationLimits | undefined,
): PluginUiApplicationLimits {
  return uiOutput(() => {
    const value =
      input === undefined
        ? {
            mounts: PLUGIN_UI_MAX_MOUNTS,
            ttlMs: PLUGIN_UI_MAX_TTL_MS,
            assetBytes: PLUGIN_UI_MAX_ASSET_BYTES,
          }
        : uiRecord(input, ["mounts", "ttlMs", "assetBytes"]);
    return Object.freeze({
      mounts: uiLimit(value.mounts, PLUGIN_UI_MAX_MOUNTS),
      ttlMs: uiLimit(value.ttlMs, PLUGIN_UI_MAX_TTL_MS),
      assetBytes: uiLimit(value.assetBytes, PLUGIN_UI_MAX_ASSET_BYTES),
    });
  });
}
