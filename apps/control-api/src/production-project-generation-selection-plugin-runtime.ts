import {
  ApplicationError,
  ExtensionReadApplicationService,
  ProjectConceptSelectionApplicationService,
  type ActorContext,
  type InvokePluginUiActionCommand,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  parseProjectGenerationSelectionUiActionRequest,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
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
import {
  assertCreativeProjectPluginPublications,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import { ProjectGenerationSelectionPluginUiOwner } from "./project-generation-selection-plugin-ui-owner.ts";

export type ProductionProjectGenerationSelectionPluginRuntime = Readonly<{
  owner: ProjectGenerationSelectionPluginUiOwner;
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

/** Configuration-only source scope and original Run reader; selecting has no execution peer. */
export function createProductionProjectGenerationSelectionPluginRuntime(
  input: Readonly<{
    configuration: CreativeProjectPluginUiConfig;
    selections: ProjectConceptSelectionApplicationService;
    taskReads: ExtensionReadApplicationService;
    ui: ProductionPluginUiConfiguration;
    identity: ProductionControlApiIdentity;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    fetch?: typeof globalThis.fetch;
  }>,
): ProductionProjectGenerationSelectionPluginRuntime {
  if (
    !(input.identity instanceof ProductionControlApiIdentity) ||
    !(input.selections instanceof ProjectConceptSelectionApplicationService) ||
    !(input.taskReads instanceof ExtensionReadApplicationService)
  )
    throw new Error(
      "production_project_generation_selection_composition_invalid",
    );
  assertCreativeProjectPluginPublications(
    input.configuration,
    input.ui.publications,
  );
  const originalReads = captureInstalledPluginReadRequestScope(input.taskReads);
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
  const owner = new ProjectGenerationSelectionPluginUiOwner({
    configuration: input.configuration,
    selections: input.selections,
    authorization: {
      authorize: async (context) => {
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
      },
    },
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    owner,
    hostUiServices: owner.hostUiServices(input.hostUiServices),
    invokeAuthenticatedRequest: (request, actor, command, signal, invoke) => {
      const parsed = parseProjectGenerationSelectionUiActionRequest({
        action: command.action,
        input: command.input,
      });
      return sourceRequests.run(
        { request, actor, signal, preparation: "configuration" },
        () =>
          originalReads.run(
            { request, actor, signal, preparation: "configuration" },
            async () => {
              const value = await invoke();
              if (
                parsed.action ===
                "crewon.project-generation-selections.v1.getConceptSelection"
              ) {
                await originalReads.assertCurrent();
                await sourceRequests.assertCurrent();
              }
              return value;
            },
          ),
      );
    },
    close: () =>
      (closing ??= Promise.allSettled([
        sourceRequests.close(),
        owner.close(),
      ]).then((results) => {
        const failures = results.flatMap((r) =>
          r.status === "rejected" ? [r.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            "production_project_generation_selection_cleanup_failed",
          );
      })),
  });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_generation_selection_unavailable",
  );
}
