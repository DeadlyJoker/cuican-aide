import {
  ApplicationError,
  ExtensionReadApplicationService,
  ProjectGenerationReadApplicationService,
  type ActorContext,
  type InvokePluginUiActionCommand,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  parseProjectGenerationReadUiActionRequest,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  PluginProjectGenerationReadActionBridge,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import {
  AbortSecurityDeadline,
  ProductionControlApiIdentity,
} from "./production-security-adapters.ts";
import { AuthorityPluginHostProfile } from "./plugin-security-adapters.ts";
import { HttpPluginProfileAuthorityPort } from "./plugin-security-http-ports.ts";
import {
  captureInstalledPluginReadRequestScope,
  InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import type { ProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { projectConceptGeneration } from "./project-generation-read-projection.ts";
import {
  assertProjectGenerationReadPluginPublications,
  captureProjectGenerationReadPluginUiConfig,
  type ProjectGenerationReadPluginUiConfig,
} from "./project-generation-read-plugin-ui-composition.ts";

export type ProductionProjectGenerationReadPluginRuntime = Readonly<{
  owner: PluginProjectGenerationReadActionBridge;
  hostUiServices: PluginUiHostServiceAvailabilityPort;
  invokeAuthenticatedRequest(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: InvokePluginUiActionCommand,
    signal: AbortSignal | undefined,
    invoke: () => Promise<PluginUiJsonValue>,
  ): Promise<PluginUiJsonValue>;
  close(): Promise<void>;
}>;

/** Configuration-only current identity/profile scopes for both the source module and original task reader. */
export function createProductionProjectGenerationReadPluginRuntime(
  input: Readonly<{
    configuration: ProjectGenerationReadPluginUiConfig;
    reads: ProjectGenerationReadApplicationService;
    taskReads: ExtensionReadApplicationService;
    ui: ProductionPluginUiConfiguration;
    identity: ProductionControlApiIdentity;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    fetch?: typeof globalThis.fetch;
  }>,
): ProductionProjectGenerationReadPluginRuntime {
  if (
    !(input.identity instanceof ProductionControlApiIdentity) ||
    !(input.reads instanceof ProjectGenerationReadApplicationService) ||
    !(input.taskReads instanceof ExtensionReadApplicationService)
  )
    throw new Error("production_project_generation_read_composition_invalid");
  const configuration = captureProjectGenerationReadPluginUiConfig(
    input.configuration,
  )!;
  assertProjectGenerationReadPluginPublications(
    configuration,
    input.ui.publications,
  );
  const originalReads = captureInstalledPluginReadRequestScope(input.taskReads);
  const get = input.reads.getConceptGeneration.bind(input.reads);
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
          if (requests === undefined) unavailable();
          return task(AbortSignal.any([signal, requests.currentSignal()]));
        }),
    },
  });
  requests = new InstalledPluginRequestOwner({
    identity: input.identity,
    profiles,
  });
  const sourceRequests = requests;
  let closed = false;
  const owner = new PluginProjectGenerationReadActionBridge({
    publications: configuration.publications,
    reads: {
      isAvailable: () => !closed,
      getConceptGeneration: async ({ context, request, authority }) => {
        await authority.assertCurrent();
        await sourceRequests.assertCurrent();
        await originalReads.assertCurrent();
        if (
          extensionCanonicalJson(context.actor) !==
            extensionCanonicalJson(sourceRequests.currentActor()) ||
          extensionCanonicalJson(context.scope) !==
            extensionCanonicalJson(sourceRequests.currentScope()) ||
          extensionCanonicalJson(context.actor) !==
            extensionCanonicalJson(originalReads.currentActor()) ||
          extensionCanonicalJson(context.scope) !==
            extensionCanonicalJson(originalReads.currentScope())
        )
          unavailable();
        const value = await get(context.actor, request);
        await sourceRequests.assertCurrent();
        await originalReads.assertCurrent();
        await authority.assertCurrent();
        return projectConceptGeneration(value);
      },
    },
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    owner,
    hostUiServices: owner.hostUiServices(input.hostUiServices),
    invokeAuthenticatedRequest: (request, actor, command, signal, invoke) => {
      parseProjectGenerationReadUiActionRequest({
        action: command.action,
        input: command.input,
      });
      return sourceRequests.run(
        { request, actor, signal, preparation: "configuration" },
        () =>
          originalReads.run(
            { request, actor, signal, preparation: "configuration" },
            async () => {
              const result = await invoke();
              await originalReads.assertCurrent();
              await sourceRequests.assertCurrent();
              return result;
            },
          ),
      );
    },
    close: () => {
      closed = true;
      return (closing ??= Promise.allSettled([
        sourceRequests.close(),
        owner.close(),
      ]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            "production_project_generation_read_plugin_cleanup_failed",
          );
      }));
    },
  });
}

function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_generation_read_unavailable",
  );
}
