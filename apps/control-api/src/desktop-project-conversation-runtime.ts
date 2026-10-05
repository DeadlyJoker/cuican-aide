import {
  ApplicationError,
  ProjectConversationApplicationService,
  type ThreadApplicationService,
  type ApplicationClock,
  type ContentDigester,
} from "@crewon/application";
import {
  appendProjectConversationUiServiceAvailability,
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
import { UuidV7ApplicationIdGenerator } from "./standalone-adapters.ts";

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
  if (foundation === undefined) return undefined;
  let owner: ProjectConversationControlOwner | undefined;
  let originalThreads: ThreadApplicationService | undefined;
  let closed = false;
  const hostUiServices = appendProjectConversationUiServiceAvailability({
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
  return Object.freeze({
    hostUiServices,
    owner: () => owner,
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
      return owner;
    },
    close: () => {
      closed = true;
      return owner?.close() ?? Promise.resolve();
    },
  });
}
