import { isProjectAssetStageControlOwner } from "./project-asset-stage-control-owner.ts";
import {
  ApplicationError,
  isPluginProjectAssetActionOwner,
  isPluginProjectAssetRecoveryActionOwner,
  type ActorContext,
  type PluginUiActionContext,
} from "@crewon/application";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import { extensionCanonicalJson } from "@crewon/domain";
import type { InvokePluginUiActionCommand } from "@crewon/application";
import type { PluginUiJsonValue } from "@crewon/contracts/plugins";
import { parseProjectAssetUiActionRequest } from "@crewon/contracts/project-assets";
import {
  isProjectAssetRecoveryNamespaceAction,
  parseProjectAssetRecoveryActionRequest,
} from "@crewon/contracts/project-asset-recovery";
import type { ProductionPluginUiConfig } from "./production-plugin-ui-composition.ts";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import {
  AbortSecurityDeadline,
  ProductionControlApiIdentity,
} from "./production-security-adapters.ts";
import { AuthorityPluginHostProfile } from "./plugin-security-adapters.ts";
import { HttpPluginProfileAuthorityPort } from "./plugin-security-http-ports.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { ProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import {
  assertProjectAssetPluginPublications,
  createProjectAssetPluginUiRuntime,
  type ProjectAssetPluginUiRuntime,
} from "./project-asset-plugin-ui-composition.ts";

export type ProductionProjectAssetPluginRuntime = ProjectAssetPluginUiRuntime &
  Readonly<{
    invokeAuthenticatedRequest(
      request: ControlApiRequestContext,
      actor: ActorContext,
      input: InvokePluginUiActionCommand,
      signal: AbortSignal | undefined,
      invoke: () => Promise<PluginUiJsonValue>,
    ): Promise<PluginUiJsonValue>;
  }>;

/** Metadata owns its actual HTTP identity/profile request, without preparing an execution peer. */
export function createProductionProjectAssetPluginRuntime(
  input: Readonly<{
    projects: PreparedCreativeProjects;
    ui: ProductionPluginUiConfiguration;
    identity: ProductionControlApiIdentity;
    fetch?: typeof globalThis.fetch;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
): ProductionProjectAssetPluginRuntime | undefined {
  const configuration = input.projects.assetUi;
  if (configuration === undefined) {
    if (input.projects.assetRecovery !== undefined)
      throw new Error("project_asset_recovery_publication_required");
    return undefined;
  }
  if (input.projects.assetService === undefined)
    throw new Error("project_asset_plugin_ui_service_required");
  if (!(input.identity instanceof ProductionControlApiIdentity))
    throw new Error("production_project_asset_identity_required");
  assertProjectAssetPluginPublications(configuration, input.ui.publications);
  assertProjectAssetPluginPublications(
    input.projects.assetRecovery,
    input.ui.publications,
  );
  if (
    input.projects.assetRecovery !== undefined &&
    input.projects.assetRecoveryService === undefined
  )
    throw new Error("project_asset_recovery_service_required");
  let requests: InstalledPluginRequestOwner | undefined;
  const deadline = new AbortSecurityDeadline();
  const profiles = new AuthorityPluginHostProfile({
    authority: new HttpPluginProfileAuthorityPort({
      ...input.ui.profileAuthority,
      fetch: input.fetch,
    }),
    timeoutMs: input.ui.timeoutMs,
    deadline: {
      run: (timeoutMs, task) =>
        deadline.run(timeoutMs, (signal) => {
          if (requests === undefined)
            throw new ApplicationError(
              "authorization",
              "plugin_ui_invocation_unavailable",
            );
          return task(AbortSignal.any([signal, requests.currentSignal()]));
        }),
    },
  });
  requests = new InstalledPluginRequestOwner({
    identity: input.identity,
    profiles,
  });
  const currentRequests = requests;
  const authorization = {
    authorize: async (context: PluginUiActionContext) => {
      await currentRequests.assertCurrent();
      if (
        extensionCanonicalJson(context.actor) !==
          extensionCanonicalJson(currentRequests.currentActor()) ||
        extensionCanonicalJson(context.scope) !==
          extensionCanonicalJson(currentRequests.currentScope())
      )
        throw new ApplicationError(
          "authorization",
          "plugin_ui_invocation_unavailable",
        );
    },
  };
  const metadata = createProjectAssetPluginUiRuntime({
    assets: input.projects.assetService,
    configuration,
    ...(input.hostUiServices === undefined
      ? {}
      : { hostUiServices: input.hostUiServices }),
    authorization,
    ...(input.projects.assetRecovery === undefined
      ? {}
      : {
          recovery: {
            configuration: input.projects.assetRecovery,
            service: input.projects.assetRecoveryService!,
            authorization,
          },
        }),
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    ...metadata,
    invokeAuthenticatedRequest: (request, actor, command, signal, invoke) => {
      const recovery = isProjectAssetRecoveryNamespaceAction(command.action);
      if (
        recovery
          ? !metadata.recoveryOwner?.supportsAction(command.action)
          : !metadata.owner.supportsAction(command.action)
      )
        throw new ApplicationError(
          "validation",
          "plugin_project_asset_action_invalid",
        );
      const raw = {
        action: command.action,
        input: command.input,
      };
      const action = recovery
        ? parseProjectAssetRecoveryActionRequest(raw)
        : parseProjectAssetUiActionRequest(raw);
      const isMutation =
        Object.hasOwn(action.input, "idempotencyKey") ||
        action.action === "crewon.project-asset-recovery.v1.acknowledge";
      return currentRequests.run(
        { request, actor, signal, preparation: "configuration" },
        async () => {
          const result = await invoke();
          // Ordinary reads still belong to the live authenticated request after the UI post-fence.
          if (!isMutation) await currentRequests.assertCurrent();
          return result;
        },
      );
    },
    close: () => {
      if (closing !== undefined) return closing;
      const withdrawn = [currentRequests.close(), metadata.close()];
      return (closing = Promise.allSettled(withdrawn).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            "production_project_asset_plugin_cleanup_failed",
          );
      }));
    },
  });
}

export function productionProjectAssetOwnerConfiguration(
  runtime: ProjectAssetPluginUiRuntime | undefined,
): Pick<
  ProductionPluginUiConfig,
  "ownedProjectAssetActions" | "ownedProjectAssetRecoveryActions"
> {
  return runtime === undefined
    ? {}
    : {
        ownedProjectAssetActions: runtime.owner,
        ...(runtime.recoveryOwner === undefined
          ? {}
          : { ownedProjectAssetRecoveryActions: runtime.recoveryOwner }),
      };
}

/** Capture failure joins only transferred genuine metadata owners, never structural copies. */
export async function closeProductionProjectAssetOwners(
  input: Readonly<{ assets: unknown; recovery: unknown; stages?: unknown }>,
): Promise<void> {
  const results = await Promise.allSettled([
    isPluginProjectAssetActionOwner(input.assets)
      ? input.assets.close()
      : undefined,
    isPluginProjectAssetRecoveryActionOwner(input.recovery)
      ? input.recovery.close()
      : undefined,
    isProjectAssetStageControlOwner(input.stages)
      ? input.stages.close()
      : undefined,
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      "production_project_asset_owners_close_failed",
    );
}

/** Capture transferred owner identities synchronously before any configuration or I/O await. */
export function captureProductionProjectAssetOwnerCleanup(
  input:
    | Pick<
        ProductionPluginUiConfig,
        | "ownedProjectAssetActions"
        | "ownedProjectAssetRecoveryActions"
        | "ownedProjectAssetStageActions"
      >
    | undefined,
): () => Promise<void> {
  const owners = Object.freeze({
    stages:
      input === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(
            input,
            "ownedProjectAssetStageActions",
          )?.value,
    assets:
      input === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(input, "ownedProjectAssetActions")
            ?.value,
    recovery:
      input === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(
            input,
            "ownedProjectAssetRecoveryActions",
          )?.value,
  });
  return () => closeProductionProjectAssetOwners(owners);
}
