import {
  ApplicationError,
  ExtensionReadApplicationService,
  ProjectConceptSelectionApplicationService,
  ProjectGenerationReadApplicationService,
  type ActorContext,
  type InvokePluginUiActionCommand,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  parseProjectGenerationReadUiActionRequest,
  parseProjectGenerationSelectionUiActionRequest,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  PluginProjectGenerationReadActionBridge,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import {
  captureInstalledPluginReadRequestScope,
  InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import {
  assertCreativeProjectPluginPublications,
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import {
  assertProjectGenerationReadPluginPublications,
  captureProjectGenerationReadPluginUiConfig,
  type ProjectGenerationReadPluginUiConfig,
} from "./project-generation-read-plugin-ui-composition.ts";
import { projectConceptGeneration } from "./project-generation-read-projection.ts";
import { ProjectGenerationSelectionPluginUiOwner } from "./project-generation-selection-plugin-ui-owner.ts";

type ProjectHistoryPluginRuntime<Owner> = Readonly<{
  owner: Owner;
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
export type ProjectGenerationReadPluginRuntime =
  ProjectHistoryPluginRuntime<PluginProjectGenerationReadActionBridge>;
export type ProjectGenerationSelectionPluginRuntime =
  ProjectHistoryPluginRuntime<ProjectGenerationSelectionPluginUiOwner>;
type Publications = readonly Readonly<{
  pluginId: string;
  packageDigest: string;
}>[];

/** Borrows the real source request owner and original reader; never acquires execution authority. */
export function createProjectGenerationReadPluginRuntime(
  input: Readonly<{
    configuration: ProjectGenerationReadPluginUiConfig;
    reads: ProjectGenerationReadApplicationService;
    taskReads: ExtensionReadApplicationService;
    requests: InstalledPluginRequestOwner;
    publications: Publications;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
): ProjectGenerationReadPluginRuntime {
  if (
    !(input.requests instanceof InstalledPluginRequestOwner) ||
    !(input.reads instanceof ProjectGenerationReadApplicationService) ||
    !(input.taskReads instanceof ExtensionReadApplicationService)
  )
    throw new Error("production_project_generation_read_composition_invalid");
  const configuration = captureProjectGenerationReadPluginUiConfig(
    input.configuration,
  );
  if (configuration === undefined)
    throw new Error("production_project_generation_read_composition_invalid");
  assertProjectGenerationReadPluginPublications(
    configuration,
    input.publications,
  );
  const originalReads = captureInstalledPluginReadRequestScope(input.taskReads);
  const sourceRequests = input.requests;
  const get = input.reads.getConceptGeneration.bind(input.reads);
  let closed = false;
  const active = () => {
    if (closed) readUnavailable();
  };
  const owner = new PluginProjectGenerationReadActionBridge({
    publications: configuration.publications,
    reads: {
      isAvailable: () => !closed,
      getConceptGeneration: async ({ context, request, authority }) => {
        active();
        await authority.assertCurrent();
        await sourceRequests.assertCurrent();
        await originalReads.assertCurrent();
        active();
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
          readUnavailable();
        const value = await get(context.actor, request);
        await sourceRequests.assertCurrent();
        await originalReads.assertCurrent();
        await authority.assertCurrent();
        active();
        return projectConceptGeneration(value);
      },
    },
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    owner,
    hostUiServices: owner.hostUiServices(input.hostUiServices),
    invokeAuthenticatedRequest: (request, actor, command, signal, invoke) => {
      active();
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
              active();
              const result = await invoke();
              await originalReads.assertCurrent();
              await sourceRequests.assertCurrent();
              active();
              return result;
            },
          ),
      );
    },
    close: () => {
      closed = true;
      return (closing ??= owner.close());
    },
  });
}

/** Selecting uses the real selection Service and its committed outcome, without a paid execution peer. */
export function createProjectGenerationSelectionPluginRuntime(
  input: Readonly<{
    configuration: CreativeProjectPluginUiConfig;
    selections: ProjectConceptSelectionApplicationService;
    taskReads: ExtensionReadApplicationService;
    requests: InstalledPluginRequestOwner;
    publications: Publications;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
): ProjectGenerationSelectionPluginRuntime {
  if (
    !(input.requests instanceof InstalledPluginRequestOwner) ||
    !(input.selections instanceof ProjectConceptSelectionApplicationService) ||
    !(input.taskReads instanceof ExtensionReadApplicationService)
  )
    throw new Error(
      "production_project_generation_selection_composition_invalid",
    );
  const configuration = captureCreativeProjectPluginUiConfig(
    input.configuration,
  );
  if (configuration === undefined)
    throw new Error(
      "production_project_generation_selection_composition_invalid",
    );
  assertCreativeProjectPluginPublications(configuration, input.publications);
  const originalReads = captureInstalledPluginReadRequestScope(input.taskReads);
  const sourceRequests = input.requests;
  let closed = false;
  const active = () => {
    if (closed) selectionUnavailable();
  };
  const owner = new ProjectGenerationSelectionPluginUiOwner({
    configuration,
    selections: input.selections,
    authorization: {
      authorize: async (context) => {
        active();
        await sourceRequests.assertCurrent();
        await originalReads.assertCurrent();
        active();
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
          selectionUnavailable();
      },
    },
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    owner,
    hostUiServices: owner.hostUiServices(input.hostUiServices),
    invokeAuthenticatedRequest: (request, actor, command, signal, invoke) => {
      active();
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
              active();
              const value = await invoke();
              if (
                parsed.action ===
                "crewon.project-generation-selections.v1.getConceptSelection"
              ) {
                await originalReads.assertCurrent();
                await sourceRequests.assertCurrent();
                active();
              }
              return value;
            },
          ),
      );
    },
    close: () => {
      closed = true;
      return (closing ??= owner.close());
    },
  });
}

function readUnavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_generation_read_unavailable",
  );
}
function selectionUnavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_generation_selection_unavailable",
  );
}
