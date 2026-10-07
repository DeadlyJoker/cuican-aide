import { randomUUID } from "node:crypto";
import {
  ApplicationError,
  CreativeProjectApplicationService,
  ExtensionConfigurationApplicationService,
  PluginInstallationApplicationService,
  ProjectAssetApplicationService,
  ProjectAssetReferenceImageApplicationService,
  ProjectAssetMediaReferenceImageApplicationService,
  ProjectMediaReferenceImageApplicationService,
  ProjectMaterialTargetApplicationService,
  ProjectMediaInputApplicationService,
  type ActorContext,
  type CreativeProjectAuthorizationPort,
  type ProjectMediaInputPermission,
} from "@crewon/application";
import { createComfyUiProjectGenerationImageResultVerifier } from "@crewon/artifacts";
import type {
  DesktopNativePluginPackageIdentity,
  DesktopProjectExecutionConfiguration,
} from "@crewon/contracts/plugins";
import type { PluginProfileScope } from "@crewon/domain";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "../standalone-adapters.ts";
import type { InstalledPluginProjectMediaInputToolsConfig } from "./installed-plugin-project-media-input-tools.ts";

type Owner = Readonly<{
  projects: DesktopProjectExecutionConfiguration;
  scope: PluginProfileScope;
  packages: readonly DesktopNativePluginPackageIdentity[];
  current(signal?: AbortSignal): void;
  actor(input: unknown): ActorContext;
  operate<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}>;

/** Main's independent metadata/stage approvals, on the Worker's borrowed parent Store.
 * No package import, network, generation, adoption or new persistence owner is added.
 */
export function createNativeProjectMediaInputTools(
  owner: Owner,
): InstalledPluginProjectMediaInputToolsConfig | undefined {
  const stages = owner.projects.mediaInputStages;
  if (stages === undefined) return undefined;
  const declared = owner.projects.mediaInputs;
  if (declared === undefined || !declared.purposes.includes("write")) denied();
  owner.current();
  assertNativeProjectMediaInputDeclaration(owner.projects, owner.packages);
  const currentActor = (actor: ActorContext) => {
    owner.current();
    owner.actor(actor);
  };
  const authorization: CreativeProjectAuthorizationPort = Object.freeze({
    authorize: async ({
      actor,
      action,
      resource,
    }: Parameters<CreativeProjectAuthorizationPort["authorize"]>[0]) => {
      currentActor(actor);
      return action === "creativeProject:read" &&
        resource.kind === "creativeProject" &&
        resource.tenantId === owner.scope.tenantId &&
        resource.spaceId === owner.scope.spaceId &&
        resource.projectId !== null
        ? { outcome: "allow" as const }
        : reject();
    },
  });
  const active = (p: ProjectMediaInputPermission) => {
    currentActor(p.actor);
    if (
      !(
        (p.action === "projectMediaInput:read" &&
          declared.purposes.includes("read")) ||
        (p.action === "projectMediaInput:write" &&
          declared.purposes.includes("write"))
      ) ||
      typeof p.resource.projectId !== "string" ||
      (p.resource.command !== null &&
        (p.resource.command.projectId !== p.resource.projectId ||
          p.resource.command.target.pluginId !== "crewon.short-drama" ||
          p.resource.command.target.profileId !== owner.scope.profileId))
    )
      denied();
  };
  const authorize = async (p: ProjectMediaInputPermission) => {
    active(p);
    return { outcome: "allow" as const };
  };
  const verifier = createComfyUiProjectGenerationImageResultVerifier({
    identities: declared.referenceIdentities,
  });
  return Object.freeze({
    version: "crewon.project-media-input-tools.v1",
    authorization,
    authorizeService: (admission, signal) =>
      owner.operate(async () => {
        owner.current(signal);
        owner.actor({
          tenantId: admission.tenantId,
          spaceId: admission.spaceId,
          actorId: admission.actorId,
          principalId: admission.principalId,
        });
        if (
          admission.action !== "project.execute" ||
          admission.profileId !== owner.scope.profileId ||
          !declared.reviews.some(
            ({ targetIdentity: identity }) =>
              identity.pluginId === admission.pluginId &&
              identity.publisherId === admission.publisherId &&
              identity.version === admission.version &&
              identity.packageDigest === admission.packageDigest,
          ) ||
          !stages.publications.some(
            (p) =>
              p.pluginId === admission.pluginId &&
              p.packageDigest === admission.packageDigest &&
              p.contributionId === admission.contributionId,
          )
        )
          denied();
      }, signal),
    createInputs({ store }) {
      owner.current();
      const clock = new SystemApplicationClock(),
        ids = new UuidV7ApplicationIdGenerator(),
        digester = new NodeSha256ContentDigester(),
        projects = store.creativeProjectStore(),
        assets = store.projectAssetStore({ verifier });
      const unavailable = async (): Promise<never> => denied();
      const installations = new PluginInstallationApplicationService({
        store: store.pluginInstallationStore(),
        profiles: {
          resolve: async (actor) => {
            currentActor(actor);
            return owner.scope;
          },
        },
        authorization: {
          authorize: async ({ actor, action, resource }) => {
            currentActor(actor);
            return action === "pluginInstallation:read" &&
              resource.kind === "pluginInstallation" &&
              resource.tenantId === owner.scope.tenantId &&
              resource.spaceId === owner.scope.spaceId &&
              resource.profileId === owner.scope.profileId &&
              (resource.pluginId === null ||
                resource.pluginId === "crewon.short-drama") &&
              (resource.packageDigest === null ||
                declared.reviews.some(
                  (r) =>
                    r.targetIdentity.packageDigest === resource.packageDigest,
                ))
              ? { outcome: "allow" as const }
              : reject();
          },
        },
        host: { install: unavailable, prepareSelection: unavailable },
        clock,
        digester,
      });
      const configurations = new ExtensionConfigurationApplicationService({
        store: store.extensionStore(),
        catalog: { list: () => [], resolve: () => null },
        host: { validateConfiguration: unavailable, evaluate: unavailable },
        authorization: {
          authorize: async ({ actor, action, resource }) => {
            currentActor(actor);
            return action === "extension:read" &&
              resource.kind === "extension" &&
              resource.tenantId === owner.scope.tenantId &&
              resource.spaceId === owner.scope.spaceId &&
              resource.pluginId === "crewon.short-drama"
              ? { outcome: "allow" as const }
              : reject();
          },
        },
        clock,
        digester,
      });
      const projectService = new CreativeProjectApplicationService({
        store: projects,
        authorization,
        clock,
        ids,
        digester,
      });
      const assetService = new ProjectAssetApplicationService({
        store: assets,
        projects,
        texts: store.projectTextStore(),
        authorization,
        clock,
        ids,
        digester,
      });
      const concepts = new ProjectAssetReferenceImageApplicationService({
        projects: projectService,
        assets: assetService,
        store: assets,
        digester,
      });
      const results = owner.projects.assetV2
        ? store.extensionStore().projectMediaResults()
        : undefined;
      const media = results
        ? new ProjectAssetMediaReferenceImageApplicationService({
            projects: projectService,
            assets: assetService,
            store: {
              loadAdoptedAssetReference: async (...args) => {
                await results.enableResultReads();
                return results.loadAdoptedAssetReference(...args);
              },
            },
            authorization: {
              authorize: async (p) => {
                currentActor(p.actor);
                if (p.action !== "projectMediaResult:read") denied();
                return { outcome: "allow" };
              },
              assertActive: (p) => {
                currentActor(p.actor);
                if (p.action !== "projectMediaResult:read") denied();
              },
            },
          })
        : undefined;
      return new ProjectMediaInputApplicationService({
        store: assets.projectMediaInputStore(),
        sources: media
          ? new ProjectMediaReferenceImageApplicationService({
              assets: assetService,
              concepts,
              media,
            })
          : concepts,
        targets: new ProjectMaterialTargetApplicationService({
          installations,
          configurations,
        }),
        reviews: declared.reviews,
        authorization: {
          authorize,
          // Only file/actor fences: never read through the policy owner's connection inside COMMIT.
          authorizeTransaction: authorize,
          assertActive: active,
        },
        clock,
        ids: { nextMediaInputId: () => randomUUID() },
      });
    },
  } satisfies InstalledPluginProjectMediaInputToolsConfig);
}

/** Validate cross-file package approval before acquiring the Native policy database. */
export function assertNativeProjectMediaInputDeclaration(
  projects: DesktopProjectExecutionConfiguration,
  packages: readonly DesktopNativePluginPackageIdentity[],
): void {
  if (projects.mediaInputStages === undefined) return;
  const declared = projects.mediaInputs;
  if (declared === undefined || !declared.purposes.includes("write")) denied();
  for (const { targetIdentity: identity } of declared.reviews)
    if (
      !packages.some(
        (pkg) =>
          pkg.pluginId === identity.pluginId &&
          pkg.publisherId === identity.publisherId &&
          pkg.version === identity.version &&
          pkg.packageDigest === identity.packageDigest,
      )
    )
      denied();
}

function reject() {
  return { outcome: "deny" as const, reasonCode: "native_media_input_denied" };
}
function denied(): never {
  throw new ApplicationError("authorization", "native_media_input_denied");
}
