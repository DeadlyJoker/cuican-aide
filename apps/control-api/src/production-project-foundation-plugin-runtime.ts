import {
  ApplicationError,
  type ActorContext,
  type InvokePluginUiActionCommand,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  projectFoundationUiCodec,
  isProjectFoundationUiMutationAction,
} from "@crewon/contracts/project-foundation";
import type { PluginUiJsonValue } from "@crewon/contracts/plugins";
import { extensionCanonicalJson } from "@crewon/domain";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { ProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { AuthorityPluginHostProfile } from "./plugin-security-adapters.ts";
import { HttpPluginProfileAuthorityPort } from "./plugin-security-http-ports.ts";
import {
  AbortSecurityDeadline,
  ProductionControlApiIdentity,
} from "./production-security-adapters.ts";
import {
  assertProjectFoundationPluginPublications,
  createProjectFoundationPluginUiRuntime,
  type ProjectFoundationPluginUiRuntime,
} from "./project-foundation-plugin-ui-composition.ts";

export type ProductionProjectFoundationPluginRuntime =
  ProjectFoundationPluginUiRuntime &
    Readonly<{
      invokeAuthenticatedRequest(
        request: ControlApiRequestContext,
        actor: ActorContext,
        command: InvokePluginUiActionCommand,
        signal: AbortSignal | undefined,
        invoke: () => Promise<PluginUiJsonValue>,
      ): Promise<PluginUiJsonValue>;
    }>;

/** HTTP identity/profile validation stays live while the actual UI mount invokes business metadata. */
export function createProductionProjectFoundationPluginRuntime(
  input: Readonly<{
    projects: PreparedCreativeProjects;
    ui: ProductionPluginUiConfiguration;
    identity: ProductionControlApiIdentity;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    fetch?: typeof globalThis.fetch;
  }>,
): ProductionProjectFoundationPluginRuntime | undefined {
  const foundation = input.projects.foundation;
  if (foundation?.pluginUi === undefined) return undefined;
  if (!(input.identity instanceof ProductionControlApiIdentity))
    throw new Error("production_project_foundation_identity_required");
  assertProjectFoundationPluginPublications(
    foundation.pluginUi,
    input.ui.publications,
  );
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
  const runtime = createProjectFoundationPluginUiRuntime({
    foundations: foundation.service,
    configuration: foundation.pluginUi,
    ...(input.hostUiServices === undefined
      ? {}
      : { hostUiServices: input.hostUiServices }),
    authorization: {
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
    },
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    ...runtime,
    invokeAuthenticatedRequest: (request, actor, command, signal, invoke) => {
      if (!runtime.owner.supportsAction(command.action))
        throw new ApplicationError(
          "validation",
          "plugin_project_foundation_action_invalid",
        );
      const action = projectFoundationUiCodec.parseRequest({
        action: command.action,
        input: command.input,
      });
      return currentRequests.run(
        { request, actor, signal, preparation: "configuration" },
        async () => {
          const result = await invoke();
          if (!isProjectFoundationUiMutationAction(action.action))
            await currentRequests.assertCurrent();
          return result;
        },
      );
    },
    close: () =>
      (closing ??= Promise.allSettled([
        currentRequests.close(),
        runtime.close(),
      ]).then((results) => {
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length)
          throw new AggregateError(
            errors,
            "production_project_foundation_cleanup_failed",
          );
      })),
  });
}
