import {
  ApplicationError,
  type ActorContext,
  type InvokePluginUiActionCommand,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  projectSourceUploadsCodec,
  parseProjectSourceUploadPartLocator,
  type ProjectSourceUploadPartLocator,
  type ProjectSourceUploadMutationResponse,
} from "@crewon/contracts/project-source-uploads";
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
  assertProjectSourceUploadPluginPublications,
  createProjectSourceUploadPluginUiRuntime,
  type ProjectSourceUploadPluginUiRuntime,
} from "./project-source-upload-plugin-ui-composition.ts";

export type ProductionProjectSourceUploadPluginRuntime =
  ProjectSourceUploadPluginUiRuntime &
    Readonly<{
      invokeAuthenticatedRequest(
        request: ControlApiRequestContext,
        actor: ActorContext,
        command: InvokePluginUiActionCommand,
        signal: AbortSignal | undefined,
        invoke: () => Promise<PluginUiJsonValue>,
      ): Promise<PluginUiJsonValue>;
      invokeAuthenticatedPartRequest(
        request: ControlApiRequestContext,
        actor: ActorContext,
        locator: ProjectSourceUploadPartLocator,
        signal: AbortSignal | undefined,
        invoke: () => Promise<ProjectSourceUploadMutationResponse>,
      ): Promise<ProjectSourceUploadMutationResponse>;
    }>;

/** HTTP identity/profile validation stays live while the actual UI mount invokes business metadata. */
export function createProductionProjectSourceUploadPluginRuntime(
  input: Readonly<{
    projects: PreparedCreativeProjects;
    ui: ProductionPluginUiConfiguration;
    identity: ProductionControlApiIdentity;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    fetch?: typeof globalThis.fetch;
  }>,
): ProductionProjectSourceUploadPluginRuntime | undefined {
  const sourceUpload = input.projects.foundation;
  if (sourceUpload?.uploadUi === undefined) return undefined;
  if (!(input.identity instanceof ProductionControlApiIdentity))
    throw new Error("production_project_source_upload_identity_required");
  assertProjectSourceUploadPluginPublications(
    sourceUpload.uploadUi,
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
  const runtime = createProjectSourceUploadPluginUiRuntime({
    uploads: sourceUpload.uploads,
    configuration: sourceUpload.uploadUi,
    ...(input.hostUiServices === undefined
      ? {}
      : { hostUiServices: input.hostUiServices }),
    authorization: {
      authorize: async (context) => assertContext(context),
      authorizePart: async (context) => assertContext(context),
    },
  });
  async function assertContext(context: PluginUiActionContext): Promise<void> {
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
  }
  let closing: Promise<void> | undefined;
  return Object.freeze({
    ...runtime,
    invokeAuthenticatedRequest: (request, actor, command, signal, invoke) => {
      if (!runtime.owner.supportsAction(command.action))
        throw new ApplicationError(
          "validation",
          "plugin_project_source_upload_action_invalid",
        );
      const action = projectSourceUploadsCodec.parseRequest({
        action: command.action,
        input: command.input,
      });
      return currentRequests.run(
        { request, actor, signal, preparation: "configuration" },
        async () => {
          const result = await invoke();
          if (action.action === "crewon.project-source-uploads.v1.status")
            await currentRequests.assertCurrent();
          return result;
        },
      );
    },
    invokeAuthenticatedPartRequest: (
      request,
      actor,
      locator,
      signal,
      invoke,
    ) => {
      parseProjectSourceUploadPartLocator(locator);
      return currentRequests.run(
        { request, actor, signal, preparation: "configuration" },
        invoke,
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
            "production_project_source_upload_cleanup_failed",
          );
      })),
  });
}
