import {
  isProjectAssetV2Action,
  isProjectAssetV2MutationAction,
  parseProjectAssetV2Request,
} from "@crewon/contracts/project-assets-v2";
import {
  createProjectAssetV2PluginUiRuntime,
  type ProjectAssetV2PluginUiRuntime,
} from "./project-asset-v2-plugin-ui-composition.ts";
import { isProjectAssetStageControlOwner } from "./project-asset-stage-control-owner.ts";
import {
  ApplicationError,
  isPluginProjectAssetActionOwner,
  isPluginProjectAssetV2ActionOwner,
  ProjectAssetV2ApplicationService,
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
    readV2Owner?: ProjectAssetV2PluginUiRuntime["owner"];
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
    if (input.projects.assetReadV2 !== undefined)
      throw new Error("project_asset_v2_read_publication_required");
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
    input.projects.assetReadV2,
    input.ui.publications,
  );
  if (
    input.projects.assetReadV2?.publications.some(
      (p) =>
        !configuration.publications.some(
          (g) =>
            p.pluginId === g.pluginId &&
            p.packageDigest === g.packageDigest &&
            p.contributionId === g.contributionId,
        ),
    )
  )
    throw new Error("project_asset_v2_read_publication_required");
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
  const readV2 =
    input.projects.assetReadV2 === undefined
      ? undefined
      : createProjectAssetV2PluginUiRuntime({
          configuration: input.projects.assetReadV2,
          assets: new ProjectAssetV2ApplicationService({
            assets: input.projects.assetService,
            access: "read-only",
          }),
          authorization,
          fallback: metadata.hostUiServices,
        });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    ...metadata,
    ...(readV2 === undefined
      ? {}
      : {
          readV2Owner: readV2.owner,
          hostUiServices: readV2.hostUiServices,
        }),
    invokeAuthenticatedRequest: (request, actor, command, signal, invoke) => {
      const v2 = isProjectAssetV2Action(command.action);
      const recovery = isProjectAssetRecoveryNamespaceAction(command.action);
      if (
        v2
          ? !readV2?.owner.supportsAction(command.action)
          : recovery
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
      const action = v2
        ? parseProjectAssetV2Request(raw)
        : recovery
          ? parseProjectAssetRecoveryActionRequest(raw)
          : parseProjectAssetUiActionRequest(raw);
      const isMutation =
        (v2 && isProjectAssetV2MutationAction(action.action)) ||
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
      const withdrawn = [
        currentRequests.close(),
        readV2?.close(),
        metadata.close(),
      ];
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
  runtime:
    | (ProjectAssetPluginUiRuntime &
        Pick<ProductionProjectAssetPluginRuntime, "readV2Owner">)
    | undefined,
): Pick<
  ProductionPluginUiConfig,
  | "ownedProjectAssetActions"
  | "ownedProjectAssetRecoveryActions"
  | "ownedProjectAssetV2ReadActions"
> {
  return runtime === undefined
    ? {}
    : {
        ownedProjectAssetActions: runtime.owner,
        ...(runtime.readV2Owner === undefined
          ? {}
          : { ownedProjectAssetV2ReadActions: runtime.readV2Owner }),
        ...(runtime.recoveryOwner === undefined
          ? {}
          : { ownedProjectAssetRecoveryActions: runtime.recoveryOwner }),
      };
}

/** Capture failure joins only transferred genuine metadata owners, never structural copies. */
export async function closeProductionProjectAssetOwners(
  input: Readonly<{
    assets: unknown;
    recovery: unknown;
    stages?: unknown;
    v2Reads?: unknown;
  }>,
): Promise<void> {
  const results = await Promise.allSettled([
    isPluginProjectAssetActionOwner(input.assets)
      ? input.assets.close()
      : undefined,
    isPluginProjectAssetRecoveryActionOwner(input.recovery)
      ? input.recovery.close()
      : undefined,
    isPluginProjectAssetV2ActionOwner(input.v2Reads)
      ? input.v2Reads.close()
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
        | "ownedProjectAssetV2ReadActions"
      >
    | undefined,
): () => Promise<void> {
  const owners = Object.freeze({
    v2Reads:
      input === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(
            input,
            "ownedProjectAssetV2ReadActions",
          )?.value,
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
