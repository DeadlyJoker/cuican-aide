import { createProjectMediaInputStagePluginOwner } from "./project-media-input-stage-plugin-runtime.ts";
import type { ProjectMediaInputStageControlOwner } from "./project-media-input-stage-control-owner.ts";
import { createProjectAssetStagePluginOwner } from "./project-asset-stage-plugin-runtime.ts";
import type { ProjectAssetStageControlOwner } from "./project-asset-stage-control-owner.ts";
import {
  ApplicationError,
  ProjectConversationApplicationService,
  type ThreadApplicationService,
  type ApplicationClock,
  type ContentDigester,
} from "@crewon/application";
import {
  appendProjectConversationUiServiceAvailability,
  appendProjectAssetStageUiServiceAvailability,
  appendProjectTextPlanUiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import type { SqliteRunStore } from "@crewon/store";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import type { DesktopPluginInstallationRuntime } from "./desktop-plugin-installation-runtime.ts";
import type { DesktopPluginConfigurationRuntime } from "./desktop-plugin-configuration-runtime.ts";
import type { DesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import type { DesktopNativePluginTaskRuntime } from "./desktop-native-plugin-task-runtime.ts";
import type { DesktopInstalledPluginTaskRuntime } from "./desktop-installed-plugin-task-runtime.ts";
import {
  assertDesktopNativePluginControlConfigCurrent,
  type DesktopNativePluginControlConfig,
} from "./desktop-native-plugin-control-environment.ts";
import { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import { captureProjectConversationNativeProvisioning } from "./project-conversation-native-provisioning.ts";
import {
  captureDesktopProjectWorkspaceObserver,
  type DesktopProjectWorkspaceObserver,
} from "./desktop-project-workspace-observer.ts";
import { UuidV7ApplicationIdGenerator } from "./standalone-adapters.ts";
import {
  createProjectTextPlanPluginUiRuntime,
  type ProjectTextPlanPluginUiRuntime,
} from "./project-text-plan-plugin-ui-composition.ts";

/** The formal composer lends its real Thread service after shared startup, before HTTP starts. */
export function createDesktopProjectConversationRuntime(
  input: Readonly<{
    projects: PreparedCreativeProjects | undefined;
    store: SqliteRunStore;
    configuration: DesktopPluginConfiguration;
    authority: DesktopPluginAuthority;
    installation: DesktopPluginInstallationRuntime;
    installed: DesktopPluginConfigurationRuntime;
    registry: DesktopPluginSourceRegistry;
    nativeControl: DesktopNativePluginControlConfig | undefined;
    nativeWorkspaceObserver?: DesktopProjectWorkspaceObserver;
    tasks: () =>
      | DesktopNativePluginTaskRuntime
      | DesktopInstalledPluginTaskRuntime
      | undefined;
    clock: ApplicationClock;
    digester: ContentDigester;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
) {
  const foundation = input.projects?.conversationFoundation;
  const nativeObserver = captureDesktopProjectWorkspaceObserver(
    input,
    "nativeWorkspaceObserver",
    foundation?.configuration.projectOwnership,
  );
  if (foundation === undefined) return undefined;
  const nativeWorkspace =
    nativeObserver === undefined
      ? undefined
      : captureProjectConversationNativeProvisioning(
          {
            observe: nativeObserver,
            registration:
              input.store.pluginProjectWorkspaceNativeRegistrationStore(),
          },
          foundation.configuration.projectOwnership,
        );
  let mediaInputStages: ProjectMediaInputStageControlOwner | undefined;
  let owner: ProjectConversationControlOwner | undefined;
  let assetStages: ProjectAssetStageControlOwner | undefined;
  let originalThreads: ThreadApplicationService | undefined;
  let closed = false;
  let plans: ProjectTextPlanPluginUiRuntime | undefined;
  const conversationServices = appendProjectConversationUiServiceAvailability({
    workspaceTargets: {
      isAvailable: (request) =>
        !closed &&
        owner !== undefined &&
        owner.supportsAction(
          "crewon.project-workspace-target.v1.resolveTarget",
        ) &&
        foundation.configuration.publications.some(
          (publication) =>
            publication.pluginId === request.candidate.descriptor.pluginId &&
            publication.packageDigest === request.candidate.packageDigest &&
            request.candidate.descriptor.contributions.some(
              (contribution) =>
                contribution.id === publication.contributionId &&
                contribution.kind === "module" &&
                contribution.slot === "main.content",
            ),
        ),
    },
    conversations: {
      isAvailable: (request) => {
        if (closed || owner === undefined) return false;
        owner.assertAvailable();
        return foundation.configuration.publications.some(
          (publication) =>
            publication.pluginId === request.candidate.descriptor.pluginId &&
            publication.packageDigest === request.candidate.packageDigest &&
            request.candidate.descriptor.contributions.some(
              (contribution) =>
                contribution.id === publication.contributionId &&
                contribution.kind === "module" &&
                contribution.slot === "main.content",
            ),
        );
      },
    },
    ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
  });
  const planFoundation = input.projects?.planFoundation;
  const previousServices =
    planFoundation === undefined
      ? conversationServices
      : appendProjectTextPlanUiServiceAvailability({
          fallback: conversationServices,
          plans: {
            isAvailable: (request) =>
              !closed &&
              plans !== undefined &&
              planFoundation.configuration.publications.some(
                (p) =>
                  p.pluginId === request.candidate.descriptor.pluginId &&
                  p.packageDigest === request.candidate.packageDigest &&
                  request.candidate.descriptor.contributions.some(
                    (c) =>
                      c.id === p.contributionId &&
                      c.kind === "module" &&
                      c.slot === "main.content",
                  ),
              ),
          },
        });
  const mediaInputFoundation = input.projects?.mediaInputStageFoundation;
  const assetFoundation = input.projects?.assetStageFoundation;
  const hostUiServices =
    assetFoundation === undefined
      ? previousServices
      : appendProjectAssetStageUiServiceAvailability({
          fallback: previousServices,
          assets: {
            isAvailable: (request) =>
              !closed &&
              assetStages !== undefined &&
              assetFoundation.configuration.publications.some(
                (p) =>
                  p.pluginId === request.candidate.descriptor.pluginId &&
                  p.packageDigest === request.candidate.packageDigest &&
                  request.candidate.descriptor.contributions.some(
                    (c) =>
                      c.id === p.contributionId &&
                      c.kind === "module" &&
                      c.slot === "main.content",
                  ),
              ),
          },
        });
  return Object.freeze({
    hostUiServices,
    owner: () => owner,
    mediaInputStages: () => mediaInputStages,
    assetStages: () => assetStages,
    textPlans: () => plans,
    bindThreads(
      threads: ThreadApplicationService,
    ): ProjectConversationControlOwner {
      if (
        closed ||
        (originalThreads !== undefined && originalThreads !== threads)
      )
        throw new Error("project_conversation_thread_service_changed");
      if (owner !== undefined) return owner;
      originalThreads = threads;
      const service = new ProjectConversationApplicationService({
        conversations: foundation.store,
        threads,
        threadStore: input.store,
        projects: foundation.projects,
        texts: foundation.texts,
        tasks: {
          createProjectConversationTurnFromHost: (...args) => {
            const tasks = input.tasks();
            if (tasks === undefined)
              throw new ApplicationError(
                "conflict",
                "project_conversation_execution_unavailable",
              );
            return tasks.core.extensionTasks.createProjectConversationTurnFromHost(
              ...args,
            );
          },
        },
        authorization: foundation.authorization,
        clock: input.clock,
        ids: new UuidV7ApplicationIdGenerator(),
        digester: input.digester,
      });
      owner = new ProjectConversationControlOwner({
        service,
        ...(nativeWorkspace === undefined ? {} : { nativeWorkspace }),
        ...(foundation.configuration.projectOwnership === undefined
          ? {}
          : { projectOwnership: foundation.configuration.projectOwnership }),
        conversations: foundation.store,
        configuration: foundation.configuration,
        installations: input.store.pluginInstallationStore(),
        requests: input.installed.requests,
        installRoot: input.configuration.installRoot,
        authorization: input.authority.ui,
        authorizePackage: async (candidate, signal) => {
          input.authority.assertScope(candidate.actor, candidate.scope);
          signal.throwIfAborted();
          const tasks = input.tasks();
          if (tasks !== undefined)
            return tasks.authority.authorizePackage(candidate, signal);
          return candidate.purpose === "read"
            ? input.registry.authorizeCandidate(candidate.candidate)
            : "deny";
        },
        assertExternal: (actor) => {
          if (closed)
            throw new ApplicationError(
              "authorization",
              "project_conversation_authority_changed",
            );
          input.authority.assertScope(actor, input.configuration.scope);
          input.installation.assertProfileOwnershipForSelectionCommit(actor);
          if (input.nativeControl !== undefined)
            assertDesktopNativePluginControlConfigCurrent(input.nativeControl);
        },
        clock: input.clock,
        digester: input.digester,
      });
      if (assetFoundation !== undefined) {
        assetStages = createProjectAssetStagePluginOwner({
          foundation: assetFoundation,
          threadStore: input.store,
          digester: input.digester,
          tasks: {
            createProjectAssetStageTurnFromHost: (...args) => {
              const actual = input.tasks();
              if (actual === undefined)
                throw new ApplicationError(
                  "conflict",
                  "project_asset_stage_execution_unavailable",
                );
              return actual.core.extensionTasks.createProjectAssetStageTurnFromHost(
                ...args,
              );
            },
          },
          authority: {
            installations: input.store.pluginInstallationStore(),
            requests: input.installed.requests,
            installRoot: input.configuration.installRoot,
            authorization: input.authority.ui,
            authorizePackage: async (candidate, signal) => {
              input.authority.assertScope(candidate.actor, candidate.scope);
              signal.throwIfAborted();
              const actual = input.tasks();
              return actual === undefined
                ? candidate.purpose === "read"
                  ? input.registry.authorizeCandidate(candidate.candidate)
                  : "deny"
                : actual.authority.authorizePackage(candidate, signal);
            },
            assertExternal: (actor) => {
              if (closed)
                throw new ApplicationError(
                  "authorization",
                  "project_asset_stage_authority_changed",
                );
              input.authority.assertScope(actor, input.configuration.scope);
              input.installation.assertProfileOwnershipForSelectionCommit(
                actor,
              );
              if (input.nativeControl !== undefined)
                assertDesktopNativePluginControlConfigCurrent(
                  input.nativeControl,
                );
            },
          },
        });
      }
      if (mediaInputFoundation !== undefined) {
        mediaInputStages = createProjectMediaInputStagePluginOwner({
          foundation: mediaInputFoundation,
          threadStore: input.store,
          digester: input.digester,
          tasks: {
            createProjectMediaInputStageTurnFromHost: (...args) => {
              const actual = input.tasks();
              if (actual === undefined)
                throw new ApplicationError(
                  "conflict",
                  "project_media_input_stage_execution_unavailable",
                );
              return actual.core.extensionTasks.createProjectMediaInputStageTurnFromHost(
                ...args,
              );
            },
          },
          authority: {
            installations: input.store.pluginInstallationStore(),
            requests: input.installed.requests,
            installRoot: input.configuration.installRoot,
            authorization: input.authority.ui,
            authorizePackage: async (candidate, signal) => {
              input.authority.assertScope(candidate.actor, candidate.scope);
              signal.throwIfAborted();
              const actual = input.tasks();
              return actual === undefined
                ? candidate.purpose === "read"
                  ? input.registry.authorizeCandidate(candidate.candidate)
                  : "deny"
                : actual.authority.authorizePackage(candidate, signal);
            },
            assertExternal: (actor) => {
              if (closed)
                throw new ApplicationError(
                  "authorization",
                  "project_media_input_stage_authority_changed",
                );
              input.authority.assertScope(actor, input.configuration.scope);
              input.installation.assertProfileOwnershipForSelectionCommit(
                actor,
              );
              if (input.nativeControl !== undefined)
                assertDesktopNativePluginControlConfigCurrent(
                  input.nativeControl,
                );
            },
          },
        });
      }
      if (planFoundation !== undefined) {
        if (input.projects?.textService === undefined)
          throw new Error("project_text_plan_text_commands_required");
        plans = createProjectTextPlanPluginUiRuntime({
          foundation: planFoundation,
          conversations: owner,
          requests: input.installed.requests,
          store: input.store,
          tasks: () => input.tasks()?.core,
          textCommands: input.projects.textService,
          ...(input.projects.structuredOutlineService === undefined
            ? {}
            : { structuredOutlines: input.projects.structuredOutlineService }),
          scope: input.configuration.scope,
          clock: input.clock,
          digester: input.digester,
        });
      }
      return owner;
    },
    close: async () => {
      closed = true;
      await mediaInputStages?.close();
      await plans?.close();
      await assetStages?.close();
      await owner?.close();
    },
  });
}
