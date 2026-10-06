import type {
  ActorContext,
  AuthorizationPort,
  CreativeProjectAuthorizationPort,
} from "@crewon/application";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import type { PluginProfileScope } from "@crewon/domain";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import { NativeAuthorityOwner } from "./installed-plugin-native-authority.ts";
import { nativeAuthorityFailure as fail } from "./installed-plugin-native-authority-files.ts";
import type { InstalledPluginNativeWorkerConfig } from "./installed-plugin-authority-config.ts";
import type {
  InstalledPluginWorkerAuthority,
  InstalledPluginReadAuthorityInput,
} from "./installed-plugin-worker-authority.ts";
import type { InstalledPluginReleaseIdentity } from "./installed-plugin-release-document.ts";
import type { InstalledPluginExecutionReadinessMetadata } from "./installed-plugin-execution-readiness-types.ts";
import { ioJson, ioRecord } from "./plugin-execution-io-network.ts";
import { createNativeProjectPlanningRuntime } from "./native-project-planning-runtime.ts";
import { createNativeProjectMediaInputTools } from "./native-project-media-input-runtime.ts";
import { createNativeProjectMediaRuntime } from "./native-project-media-runtime.ts";
import { desktopProjectMaterialStorageFromEnvironment } from "@crewon/media-runtime/desktop-project-material-archive";
import type { InstalledPluginProjectMediaConfig } from "./installed-plugin-project-media-composition.ts";
export function createInstalledPluginNativeWorkerAuthority(
  config: InstalledPluginNativeWorkerConfig,
): InstalledPluginWorkerAuthority {
  const owner = new NativeAuthorityOwner(config);
  if (
    owner.projects?.version === "crewon.desktop-project-execution.v1" &&
    owner.projects.mediaGenerations !== undefined
  ) {
    void owner.close();
    throw new Error("native_project_media_async_preparation_required");
  }
  return composeNativeWorkerAuthority(owner);
}

/** Main waits for installed graph verification before publishing a media-capable Worker. */
export async function prepareInstalledPluginNativeWorkerAuthority(
  config: InstalledPluginNativeWorkerConfig,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<InstalledPluginWorkerAuthority> {
  const owner = new NativeAuthorityOwner(config);
  try {
    const projectMedia =
      owner.projects?.version === "crewon.desktop-project-execution.v1" &&
      owner.projects.mediaGenerations !== undefined
        ? await createNativeProjectMediaRuntime(
            {
              projects: owner.projects,
              authority: owner.files.authority,
              current: owner.current.bind(owner),
              actor: owner.actor.bind(owner),
            },
            desktopProjectMaterialStorageFromEnvironment(environment),
          )
        : undefined;
    owner.current();
    return composeNativeWorkerAuthority(owner, projectMedia);
  } catch (error) {
    try {
      await owner.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "native_project_media_startup_cleanup_failed",
      );
    }
    throw error;
  }
}
function composeNativeWorkerAuthority(
  owner: NativeAuthorityOwner,
  projectMedia?: InstalledPluginProjectMediaConfig,
): InstalledPluginWorkerAuthority {
  const config = owner.config;
  const authorizeRead = (
    input: InstalledPluginReadAuthorityInput,
    signal: AbortSignal,
  ) =>
    owner.operate(async () => {
      const value = ioRecord(input, ["identity", "scope", "purpose"]);
      owner.scope(value.scope);
      if (value.purpose !== "read") fail("purpose_invalid");
      return (await owner.package(
        value.identity as InstalledPluginReleaseIdentity,
        "read",
      ))
        ? ("allow" as const)
        : ("deny" as const);
    }, signal);
  const resolveProfile = (actor: ActorContext, signal: AbortSignal) =>
    owner.operate(async () => {
      owner.actor(actor);
      return owner.files.authority.scope;
    }, signal);
  const projectMediaInputs =
    owner.projects?.version === "crewon.desktop-project-execution.v1"
      ? createNativeProjectMediaInputTools({
          projects: owner.projects,
          scope: owner.files.authority.scope,
          packages: owner.files.authority.packages,
          current: owner.current.bind(owner),
          actor: owner.actor.bind(owner),
          operate: owner.operate.bind(owner),
        })
      : undefined;
  return Object.freeze({
    installRoot: config.installRoot,
    releaseDocumentPath: config.releaseDocumentPath,
    authorizeRead,
    resolveProfile,
    ...(owner.projects?.planningDrafts === undefined
      ? {}
      : {
          projectPlanning: createNativeProjectPlanningRuntime({
            actor: owner.files.authority.actor,
            scope: owner.files.authority.scope,
            projects: owner.projects,
            installRoot: config.installRoot,
            store: owner.store,
            current: owner.current.bind(owner),
            operate: owner.operate.bind(owner),
            release: owner.release.bind(owner),
            target: owner.target.bind(owner),
          }),
        }),
    installedPluginExecution: Object.freeze({
      installRoot: config.installRoot,
      ...(projectMediaInputs === undefined ? {} : { projectMediaInputs }),
      ...(projectMedia === undefined ? {} : { projectMedia }),
      ...(owner.projects?.conversations === undefined
        ? {}
        : {
            projectTools: Object.freeze({
              version: "crewon.project-tools.v1" as const,
              authorization: Object.freeze({
                authorize: (
                  input: Parameters<
                    CreativeProjectAuthorizationPort["authorize"]
                  >[0],
                ) => owner.operate(() => owner.projectPolicy(input)),
              }),
              authorizeService: (
                admission: import("@crewon/domain").PluginTaskAdmission,
                signal: AbortSignal,
              ) =>
                owner.operate(async () => {
                  owner.current(signal);
                  owner.actor({
                    tenantId: admission.tenantId,
                    spaceId: admission.spaceId,
                    principalId: admission.principalId,
                    actorId: admission.actorId,
                  });
                  if (
                    !owner.projects!.conversations!.publications.some(
                      (p) =>
                        p.pluginId === admission.pluginId &&
                        p.packageDigest === admission.packageDigest &&
                        p.contributionId === admission.contributionId,
                    )
                  )
                    fail("project_service_unapproved");
                }, signal),
            }),
          }),
      ...(owner.projects?.assetStages === undefined
        ? {}
        : {
            projectAssetTools: Object.freeze({
              version: "crewon.project-asset-tools.v1" as const,
              authorization: Object.freeze({
                authorize: (
                  input: Parameters<
                    CreativeProjectAuthorizationPort["authorize"]
                  >[0],
                ) => owner.operate(() => owner.projectPolicy(input)),
              }),
              authorizeService: (
                admission: import("@crewon/domain").PluginTaskAdmission,
                signal: AbortSignal,
              ) =>
                owner.operate(async () => {
                  owner.current(signal);
                  owner.actor({
                    tenantId: admission.tenantId,
                    spaceId: admission.spaceId,
                    principalId: admission.principalId,
                    actorId: admission.actorId,
                  });
                  if (
                    !owner.projects?.assetStages?.publications.some(
                      (p) =>
                        p.pluginId === admission.pluginId &&
                        p.packageDigest === admission.packageDigest &&
                        p.contributionId === admission.contributionId,
                    )
                  )
                    fail("asset_service_unapproved");
                }, signal),
            }),
          }),
      authorization: Object.freeze({
        authorize: (input: Parameters<AuthorizationPort["authorize"]>[0]) =>
          owner.operate(() => owner.policy(input)),
      }),
      resolveActor: (
        input: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
        signal: AbortSignal,
      ) =>
        owner.operate(async () => {
          const value = ioRecord(input, ["tenantId", "spaceId", "actorId"]),
            actor = owner.files.authority.actor;
          return Object.entries(value).every(
            ([field, expected]) =>
              actor[field as keyof ActorContext] === expected,
          )
            ? actor
            : null;
        }, signal),
      authorizePackage: (
        input: Readonly<{
          candidate: Readonly<{ descriptor: unknown; packageDigest: string }>;
          scope: PluginProfileScope;
          purpose: "submit" | "observe";
        }>,
        signal: AbortSignal,
      ) =>
        owner.operate(async () => {
          const value = ioRecord(input, ["candidate", "scope", "purpose"]);
          owner.scope(value.scope);
          if (value.purpose !== "submit" && value.purpose !== "observe")
            fail("purpose_invalid");
          const candidate = ioRecord(ioJson(value.candidate, 128 * 1024), [
              "descriptor",
              "packageDigest",
            ]),
            descriptor = parsePluginPackageDescriptor(candidate.descriptor);
          return (await owner.package(
            {
              pluginId: descriptor.pluginId,
              publisherId: descriptor.publisherId,
              version: descriptor.version,
              packageDigest: candidate.packageDigest as string,
            },
            value.purpose,
          ))
            ? ("allow" as const)
            : ("deny" as const);
        }, signal),
      authorizeCandidatePackage: (
        input: Readonly<{
          candidate: Readonly<{ descriptor: unknown; packageDigest: string }>;
          scope: PluginProfileScope;
          expectedSelectionRevision: number;
        }>,
        signal: AbortSignal,
      ) =>
        owner.operate(async () => {
          const value = ioRecord(input, [
            "candidate",
            "scope",
            "expectedSelectionRevision",
          ]);
          owner.scope(value.scope);
          const candidate = ioRecord(ioJson(value.candidate, 128 * 1024), [
              "descriptor",
              "packageDigest",
            ]),
            descriptor = parsePluginPackageDescriptor(candidate.descriptor);
          return (await owner.candidatePackage(
            {
              pluginId: descriptor.pluginId,
              publisherId: descriptor.publisherId,
              version: descriptor.version,
              packageDigest: candidate.packageDigest as string,
            },
            value.expectedSelectionRevision as number,
          ))
            ? ("allow" as const)
            : ("deny" as const);
        }, signal),
      executionIo: Object.freeze({
        resolveNetwork: (
          context: PluginToolRuntimeContext,
          signal: AbortSignal,
        ) => owner.operate(() => owner.runNetwork(context, signal), signal),
        resolveReadinessNetwork: (
          metadata: InstalledPluginExecutionReadinessMetadata,
          signal: AbortSignal,
        ) =>
          owner.operate(
            () =>
              owner.network(
                ioRecord(ioJson(metadata, 128 * 1024), [
                  "identity",
                  "scope",
                  "configuration",
                  "target",
                  "purpose",
                ]) as unknown as InstalledPluginExecutionReadinessMetadata,
                false,
              ),
            signal,
          ),
      }),
      ...(config.historicalScope === null
        ? {}
        : {
            historicalQuery: Object.freeze({
              scope: config.historicalScope,
              resolveProfile,
            }),
          }),
    }),
    close: () => owner.close(),
  });
}
