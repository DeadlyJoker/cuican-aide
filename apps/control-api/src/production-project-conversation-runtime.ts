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
import { PostgresDomainStore } from "@crewon/store";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { ProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import {
  AuthorityPluginHostProfile,
  DynamicPluginUiAuthorization,
} from "./plugin-security-adapters.ts";
import {
  HttpPluginProfileAuthorityPort,
  HttpPluginUiPolicyDecisionPort,
} from "./plugin-security-http-ports.ts";
import {
  ProductionControlApiIdentity,
  AbortSecurityDeadline,
} from "./production-security-adapters.ts";
import type { InstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { installedProjectConversationTaskAuthority } from "./installed-plugin-task-runtime-core.ts";
import type { ProductionPluginSourceRegistry } from "./production-plugin-source-registry.ts";
import { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import { UuidV7ApplicationIdGenerator } from "./standalone-adapters.ts";
import { assertCreativeProjectPluginPublications } from "./creative-project-plugin-ui-composition.ts";

/** Independent approved metadata; real task Core lends execution authority only when start is requested. */
export function createProductionProjectConversationRuntime(
  input: Readonly<{
    projects: PreparedCreativeProjects | undefined;
    store: PostgresDomainStore;
    ui: ProductionPluginUiConfiguration;
    identity: ProductionControlApiIdentity;
    registry: ProductionPluginSourceRegistry | undefined;
    tasks: () => InstalledPluginTaskRuntimeCore | undefined;
    clock: ApplicationClock;
    digester: ContentDigester;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
) {
  const foundation = input.projects?.conversationFoundation;
  if (foundation === undefined) return undefined;
  assertCreativeProjectPluginPublications(
    foundation.configuration,
    input.ui.publications,
  );
  const deadline = new AbortSecurityDeadline();
  const metadataRequests = new InstalledPluginRequestOwner({
    identity: input.identity,
    profiles: new AuthorityPluginHostProfile({
      authority: new HttpPluginProfileAuthorityPort({
        ...input.ui.profileAuthority,
      }),
      timeoutMs: input.ui.timeoutMs,
      deadline,
    }),
  });
  const metadataAuthorization = new DynamicPluginUiAuthorization({
    policy: new HttpPluginUiPolicyDecisionPort({ ...input.ui.policyAuthority }),
    timeoutMs: input.ui.timeoutMs,
    deadline,
  });
  let owner: ProjectConversationControlOwner | undefined,
    closed = false;
  const hostUiServices = appendProjectConversationUiServiceAvailability({
    conversations: {
      isAvailable: (request) =>
        !closed &&
        foundation.configuration.publications.some(
          (entry) =>
            entry.pluginId === request.candidate.descriptor.pluginId &&
            entry.packageDigest === request.candidate.packageDigest &&
            request.candidate.descriptor.contributions.some(
              (c) =>
                c.id === entry.contributionId &&
                c.kind === "module" &&
                c.slot === "main.content",
            ),
        ),
    },
    ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
  });
  return Object.freeze({
    hostUiServices,
    owner: () => owner,
    bindThreads(threads: ThreadApplicationService) {
      if (closed) throw new Error("project_conversation_unavailable");
      if (owner !== undefined) return owner;
      const core = input.tasks(),
        taskAuthority =
          core === undefined
            ? undefined
            : installedProjectConversationTaskAuthority(core),
        requests = taskAuthority?.requests ?? metadataRequests;
      const service = new ProjectConversationApplicationService({
        conversations: foundation.store,
        threads,
        threadStore: input.store,
        projects: foundation.projects,
        texts: foundation.texts,
        authorization: foundation.authorization,
        clock: input.clock,
        ids: new UuidV7ApplicationIdGenerator(),
        digester: input.digester,
        tasks: {
          createProjectConversationTurnFromHost: (...args) => {
            const actual = input.tasks();
            if (actual === undefined)
              throw new ApplicationError(
                "conflict",
                "project_conversation_execution_unavailable",
              );
            return actual.extensionTasks.createProjectConversationTurnFromHost(
              ...args,
            );
          },
        },
      });
      owner = new ProjectConversationControlOwner({
        service,
        conversations: foundation.store,
        configuration: foundation.configuration,
        installations: input.store.pluginInstallationStore(),
        requests,
        installRoot: input.ui.installRoot,
        authorization: taskAuthority?.authorization ?? metadataAuthorization,
        clock: input.clock,
        digester: input.digester,
        authorizePackage: async (candidate, signal) => {
          if (taskAuthority !== undefined)
            return taskAuthority.authorizePackage(candidate, signal);
          await requests.assertCurrent();
          return candidate.purpose === "read" && input.registry !== undefined
            ? input.registry.authorizeCandidate(candidate.candidate)
            : "deny";
        },
        assertExternal: () => {
          if (closed)
            throw new ApplicationError(
              "authorization",
              "project_conversation_authority_changed",
            );
          taskAuthority?.assertActive();
          requests.currentSignal().throwIfAborted();
        },
      });
      return owner;
    },
    close: async () => {
      closed = true;
      await Promise.allSettled([owner?.close(), metadataRequests.close()]);
    },
  });
}
