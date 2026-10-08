import { createDesktopAdoptedMediaReader } from "@crewon/media-runtime/desktop-adopted-media-reader";
import {
  ApplicationError,
  type ActorContext,
  type ApplicationClock,
  type ExtensionConfigurationApplicationService,
  type ProjectMediaGenerationPermission,
  type ProjectMediaInputPermission,
} from "@crewon/application";
import { createComfyUiProjectGenerationImageResultVerifier } from "@crewon/artifacts";
import { createProjectMediaMaterialRuntime } from "@crewon/media-runtime/project-media-material-runtime";
import { createComfyUiProjectReferenceMaterialAdapter } from "@crewon/media-runtime/comfyui-project-reference-material-adapter";
import {
  loadDesktopProjectMaterialArchive,
  type DesktopProjectMaterialStorage,
} from "@crewon/media-runtime/desktop-project-material-archive";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopNativePluginControlConfig } from "./desktop-native-plugin-control-environment.ts";
import { assertDesktopNativeProjectMediaInputDeclaration } from "./desktop-native-project-media-input-composition.ts";
import type { InstalledProjectMediaGenerationConfiguration } from "./installed-project-media-generation-configuration.ts";
import { createDesktopNativeNetworkDnsResolver } from "@crewon/media-runtime/desktop-native-network-dns";

/** Original Native request/commit authority supplies these hooks; plugin JSON supplies none. */
export function composeDesktopNativeProjectMediaGenerationConfiguration(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    nativeControl: DesktopNativePluginControlConfig;
    configurations: ExtensionConfigurationApplicationService;
    storage?: DesktopProjectMaterialStorage;
    clock: ApplicationClock;
    assertRequestCurrent(actor: ActorContext): Promise<void>;
    assertTransactionCurrent(actor: ActorContext): void;
  }>,
): InstalledProjectMediaGenerationConfiguration | undefined {
  if (
    input.configuration.schemaVersion !==
      "crewon.desktop-plugin-bootstrap.v3" ||
    input.configuration.projects.mediaGenerations === undefined
  )
    return undefined;
  assertDesktopNativeProjectMediaInputDeclaration(input);
  if (input.storage === undefined)
    throw new Error("desktop_native_project_material_storage_required");
  const storage = Object.freeze({ ...input.storage }),
    scope = input.configuration.scope,
    declared = input.configuration.projects.mediaInputs!,
    publications = input.configuration.projects.mediaGenerations.publications,
    reviews = declared.reviews.filter((review) =>
      publications.some(
        (p) =>
          p.pluginId === review.targetIdentity.pluginId &&
          p.packageDigest === review.targetIdentity.packageDigest,
      ),
    );
  const active = (actor: ActorContext) => {
    input.assertTransactionCurrent(actor);
    assertDesktopNativeProjectMediaInputDeclaration(input);
  };
  const current = async (actor: ActorContext) => {
    await input.assertRequestCurrent(actor);
    active(actor);
  };
  const dns = createDesktopNativeNetworkDnsResolver({
    hostnames: input.nativeControl.authority.networkGrants.map(
      (grant) => new URL(grant.baseUrl).hostname,
    ),
    assertCurrent: () => active(input.nativeControl.authority.actor),
  });
  const metadataActive = (p: ProjectMediaInputPermission) => {
    active(p.actor);
    if (
      (p.action !== "projectMediaInput:read" &&
        p.action !== "projectMediaInput:qualify") ||
      !p.resource.projectId ||
      (p.resource.command !== null &&
        (p.resource.command.projectId !== p.resource.projectId ||
          p.resource.command.target.pluginId !== "crewon.short-drama" ||
          p.resource.command.target.profileId !== scope.profileId))
    )
      denied();
  };
  const generationActive = (p: ProjectMediaGenerationPermission) => {
    active(p.actor);
    if (p.action !== "projectMedia:generate") denied();
  };
  const verifier = createComfyUiProjectGenerationImageResultVerifier({
    identities: declared.referenceIdentities,
  });
  const hasPath = (
    paths: DesktopNativePluginControlConfig["authority"]["networkGrants"][number]["paths"],
    method: "GET" | "POST",
    path: string,
  ) => paths.some((p) => p.method === method && "path" in p && p.path === path);
  return Object.freeze({
    version: "crewon.project-media-generation-control.v1",
    profileId: scope.profileId,
    reviews,
    verifier,
    metadataAuthorization: {
      authorize: async (p) => {
        await current(p.actor);
        metadataActive(p);
        return allow();
      },
      authorizeTransaction: async (p) => {
        metadataActive(p);
        return allow();
      },
      assertActive: metadataActive,
    },
    authorization: {
      authorize: async (p) => {
        generationActive(p);
        return allow();
      },
      assertActive: generationActive,
    },
    createMaterials: async (materialScope) => {
      materialScope.signal.throwIfAborted();
      assertDesktopNativeProjectMediaInputDeclaration(input);
      const transaction = async (actor: ActorContext) => {
        await materialScope.assertTransactionCurrent(actor);
        active(actor);
      };
      const request = async (actor: ActorContext) => {
        await materialScope.assertCurrent(actor);
        await current(actor);
      };
      const archive = loadDesktopProjectMaterialArchive(storage, scope);
      let adopted:
        | Awaited<ReturnType<typeof createDesktopAdoptedMediaReader>>
        | undefined;
      try {
        if (
          input.configuration.schemaVersion ===
            "crewon.desktop-plugin-bootstrap.v3" &&
          input.configuration.projects.assetV2
        ) {
          adopted = await createDesktopAdoptedMediaReader({
            store: materialScope.store,
            storage,
            scope,
            reviews,
            materialArchiveId: archive.archiveId,
            clock: input.clock,
            signal: materialScope.signal,
            assertCurrent: request,
            assertActive: active,
          });
        }
        const runtime = await createProjectMediaMaterialRuntime({
          network: { dns },
          ...(adopted ? { adoptedMedia: adopted.config } : {}),
          store: materialScope.store,
          configurations: input.configurations,
          clock: input.clock,
          signal: materialScope.signal,
          archive,
          reviews,
          metadata: materialScope.metadataAuthorization,
          verifier,
          sourceAdapter: createComfyUiProjectReferenceMaterialAdapter({
            identities: declared.referenceIdentities,
          }),
          profiles: {
            resolve: async (actor) => {
              await transaction(actor);
              return scope;
            },
          },
          projects: {
            authorize: async ({ actor, action, resource }) => {
              await transaction(actor);
              if (
                action !== "creativeProject:read" ||
                resource.kind !== "creativeProject" ||
                resource.tenantId !== scope.tenantId ||
                resource.spaceId !== scope.spaceId ||
                !resource.projectId
              )
                denied();
              return allow();
            },
          },
          installations: {
            authorize: async ({ actor, action, resource }) => {
              await transaction(actor);
              if (
                action !== "pluginInstallation:read" ||
                resource.kind !== "pluginInstallation" ||
                resource.tenantId !== scope.tenantId ||
                resource.spaceId !== scope.spaceId ||
                resource.profileId !== scope.profileId ||
                !publications.some(
                  (p) =>
                    (resource.pluginId === null ||
                      p.pluginId === resource.pluginId) &&
                    (resource.packageDigest === null ||
                      p.packageDigest === resource.packageDigest),
                )
              )
                denied();
              return allow();
            },
          },
          read: {
            authorize: async ({ actor, action, resource }) => {
              await request(actor);
              if (
                action !== "projectReferenceMaterial:read" ||
                new URL(resource.path, resource.origin).pathname !== "/view" ||
                !input.nativeControl.authority.networkGrants.some(
                  (g) =>
                    g.pluginId === resource.pluginId &&
                    g.version === resource.pluginVersion &&
                    g.packageDigest === resource.packageDigest &&
                    g.baseUrl === resource.origin &&
                    hasPath(g.paths, "GET", "/view"),
                )
              )
                denied();
              return allow();
            },
          },
          freeze: {
            authorize: async ({ actor, action, resource }) => {
              await request(actor);
              if (
                action !== "projectReferenceMaterial:freeze" ||
                resource.archiveId !== archive.archiveId
              )
                denied();
              return allow();
            },
          },
          preparation: {
            authorize: async ({ actor, action, resource }) => {
              const check =
                action === "projectMaterial:prepare" ? transaction : request;
              await check(actor);
              const target = resource.request.target;
              active(resource.request.source.actor);
              if (
                target.profileId !== scope.profileId ||
                !publications.some((p) => p.pluginId === target.pluginId)
              )
                denied();
              // Configuration reads are only for transport, never inside the prepare/Turn transaction.
              if (
                action === "projectMaterial:upload" ||
                action === "projectMaterial:observe"
              ) {
                const c = await input.configurations.getConfiguration(actor, {
                  pluginId: target.pluginId,
                  revision: target.configurationRevision,
                });
                await check(actor);
                if (
                  !c ||
                  !reviews.some(
                    (r) =>
                      r.targetIdentity.pluginId === c.pluginId &&
                      r.targetIdentity.version === c.pluginVersion &&
                      r.targetIdentity.manifestDigest === c.manifestDigest &&
                      r.targetIdentity.implementationDigest ===
                        c.implementationDigest &&
                      input.nativeControl.authority.networkGrants.some(
                        (g) =>
                          g.pluginId === r.targetIdentity.pluginId &&
                          g.publisherId === r.targetIdentity.publisherId &&
                          g.version === r.targetIdentity.version &&
                          g.packageDigest === r.targetIdentity.packageDigest &&
                          g.baseUrlParameter === "baseUrl" &&
                          g.baseUrl === c.parameters.baseUrl &&
                          hasPath(
                            g.paths,
                            action === "projectMaterial:upload"
                              ? "POST"
                              : "GET",
                            action === "projectMaterial:upload"
                              ? "/upload/image"
                              : "/view",
                          ),
                      ),
                  )
                )
                  denied();
              } else if (action !== "projectMaterial:prepare") denied();
              return allow();
            },
            assertActive: ({ request: value }) => {
              materialScope.assertActive(value.source.actor);
              active(value.source.actor);
              if (
                value.target.profileId !== scope.profileId ||
                !publications.some((p) => p.pluginId === value.target.pluginId)
              )
                denied();
            },
          },
        });
        try {
          materialScope.signal.throwIfAborted();
          assertDesktopNativeProjectMediaInputDeclaration(input);
        } catch (error) {
          await runtime.close();
          throw error;
        }
        return Object.freeze({
          materials: runtime.materials,
          close: async () => {
            try {
              await runtime.close();
            } finally {
              await adopted?.close();
            }
          },
        });
      } catch (error) {
        await adopted?.close();
        throw error;
      } finally {
        archive.encryptionKey.fill(0);
      }
    },
  } satisfies InstalledProjectMediaGenerationConfiguration);
}
function allow() {
  return { outcome: "allow" as const };
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_native_project_media_generation_denied",
  );
}
