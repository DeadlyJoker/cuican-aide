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
  appendProjectAssetStageUiServiceAvailability,
  appendProjectConversationUiServiceAvailability,
  appendProjectTextPlanUiServiceAvailability,
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
import {
  createProjectTextPlanPluginUiRuntime,
  type ProjectTextPlanPluginUiRuntime,
} from "./project-text-plan-plugin-ui-composition.ts";

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
  let mediaInputStages: ProjectMediaInputStageControlOwner | undefined;
  let owner: ProjectConversationControlOwner | undefined,
    closed = false;
  let plans: ProjectTextPlanPluginUiRuntime | undefined;
  let assets: ProjectAssetStageControlOwner | undefined;
  let closing: Promise<void> | undefined;
  const conversationServices = appendProjectConversationUiServiceAvailability({
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
  const planFoundation = input.projects?.planFoundation;
  if (planFoundation !== undefined)
    assertCreativeProjectPluginPublications(
      planFoundation.configuration,
      input.ui.publications,
    );
  const predecessorServices =
    planFoundation === undefined
      ? conversationServices
      : appendProjectTextPlanUiServiceAvailability({
          fallback: conversationServices,
          plans: {
            isAvailable: (request) =>
              !closed &&
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
  if (mediaInputFoundation !== undefined)
    assertCreativeProjectPluginPublications(
      mediaInputFoundation.configuration,
      input.ui.publications,
    );
  const assetFoundation = input.projects?.assetStageFoundation;
  if (assetFoundation !== undefined)
    assertCreativeProjectPluginPublications(
      assetFoundation.configuration,
      input.ui.publications,
    );
  const hostUiServices =
    assetFoundation === undefined
      ? predecessorServices
      : appendProjectAssetStageUiServiceAvailability({
          fallback: predecessorServices,
          assets: {
            isAvailable: (request) =>
              !closed &&
              request.requirement.apiVersion === "1" &&
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
    textPlans: () => plans,
    assetStages: () => assets,
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
      if (assetFoundation !== undefined) {
        assets = createProjectAssetStagePluginOwner({
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
              return actual.extensionTasks.createProjectAssetStageTurnFromHost(
                ...args,
              );
            },
          },
          authority: {
            installations: input.store.pluginInstallationStore(),
            requests,
            installRoot: input.ui.installRoot,
            authorization:
              taskAuthority?.authorization ?? metadataAuthorization,
            authorizePackage: async (candidate, signal) => {
              if (taskAuthority !== undefined)
                return taskAuthority.authorizePackage(candidate, signal);
              await requests.assertCurrent();
              return candidate.purpose === "read" &&
                input.registry !== undefined
                ? input.registry.authorizeCandidate(candidate.candidate)
                : "deny";
            },
            assertExternal: () => {
              if (closed)
                throw new ApplicationError(
                  "authorization",
                  "project_asset_stage_authority_changed",
                );
              taskAuthority?.assertActive();
              requests.currentSignal().throwIfAborted();
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
              return actual.extensionTasks.createProjectMediaInputStageTurnFromHost(
                ...args,
              );
            },
          },
          authority: {
            installations: input.store.pluginInstallationStore(),
            requests,
            installRoot: input.ui.installRoot,
            authorization:
              taskAuthority?.authorization ?? metadataAuthorization,
            authorizePackage: async (candidate, signal) => {
              if (taskAuthority !== undefined)
                return taskAuthority.authorizePackage(candidate, signal);
              await requests.assertCurrent();
              return candidate.purpose === "read" &&
                input.registry !== undefined
                ? input.registry.authorizeCandidate(candidate.candidate)
                : "deny";
            },
            assertExternal: () => {
              if (closed)
                throw new ApplicationError(
                  "authorization",
                  "project_media_input_stage_authority_changed",
                );
              taskAuthority?.assertActive();
              requests.currentSignal().throwIfAborted();
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
          requests,
          store: input.store,
          tasks: input.tasks,
          textCommands: input.projects.textService,
          ...(input.projects.structuredOutlineService === undefined
            ? {}
            : { structuredOutlines: input.projects.structuredOutlineService }),
          clock: input.clock,
          digester: input.digester,
        });
      }
      return owner;
    },
    close: () => {
      closed = true;
      return (closing ??= Promise.allSettled([
        plans?.close(),
        assets?.close(),
        mediaInputStages?.close(),
        owner?.close(),
        metadataRequests.close(),
      ]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            "production_project_conversation_cleanup_failed",
          );
      }));
    },
  });
}
