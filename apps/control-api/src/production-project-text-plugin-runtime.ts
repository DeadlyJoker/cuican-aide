import { ApplicationError, type ActorContext } from "@crewon/application";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import { extensionCanonicalJson } from "@crewon/domain";
import type { InvokePluginUiActionCommand } from "@crewon/application";
import type { PluginUiJsonValue } from "@crewon/contracts/plugins";
import { parseProjectTextUiActionRequest } from "@crewon/contracts/project-texts-ui";
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
  assertProjectTextPluginPublications,
  createProjectTextPluginUiRuntime,
  type ProjectTextPluginUiRuntime,
} from "./project-text-plugin-ui-composition.ts";

export type ProductionProjectTextPluginRuntime = ProjectTextPluginUiRuntime &
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
export function createProductionProjectTextPluginRuntime(
  input: Readonly<{
    projects: PreparedCreativeProjects;
    ui: ProductionPluginUiConfiguration;
    identity: ProductionControlApiIdentity;
    fetch?: typeof globalThis.fetch;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
): ProductionProjectTextPluginRuntime | undefined {
  const configuration = input.projects.textUi;
  if (configuration === undefined) return undefined;
  if (input.projects.textService === undefined)
    throw new Error("project_text_plugin_ui_service_required");
  if (!(input.identity instanceof ProductionControlApiIdentity))
    throw new Error("production_project_text_identity_required");
  assertProjectTextPluginPublications(configuration, input.ui.publications);
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
  const metadata = createProjectTextPluginUiRuntime({
    texts: input.projects.textService!,
    configuration,
    ...(input.hostUiServices === undefined
      ? {}
      : { hostUiServices: input.hostUiServices }),
    authorization: {
      authorize: async (context) => {
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
    ...metadata,
    invokeAuthenticatedRequest: (request, actor, command, signal, invoke) => {
      if (!metadata.owner.supportsAction(command.action))
        throw new ApplicationError(
          "validation",
          "plugin_project_text_action_invalid",
        );
      const action = parseProjectTextUiActionRequest({
        action: command.action,
        input: command.input,
      });
      const isMutation = Object.hasOwn(action.input, "idempotencyKey");
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
            "production_project_text_plugin_cleanup_failed",
          );
      }));
    },
  });
}
