import { createDesktopAdoptedMediaReader } from "@crewon/media-runtime/desktop-adopted-media-reader";
import {
  ApplicationError,
  ExtensionConfigurationApplicationService,
  type ActorContext,
  type ProjectMediaInputPermission,
} from "@crewon/application";
import { createComfyUiProjectGenerationImageResultVerifier } from "@crewon/artifacts";
import type {
  DesktopNativePluginAuthority,
  DesktopProjectExecutionConfiguration,
} from "@crewon/contracts/plugins";
import { createProjectMediaMaterialRuntime } from "@crewon/media-runtime/project-media-material-runtime";
import { createComfyUiProjectReferenceMaterialAdapter } from "@crewon/media-runtime/comfyui-project-reference-material-adapter";
import {
  loadDesktopProjectMaterialArchive,
  type DesktopProjectMaterialStorage,
} from "@crewon/media-runtime/desktop-project-material-archive";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
} from "../standalone-adapters.ts";
import type { InstalledPluginProjectMediaConfig } from "./installed-plugin-project-media-composition.ts";
import { loadNativeProjectMediaReviews } from "./native-project-media-reviews.ts";
import type { NetworkDnsResolver } from "../network-egress.ts";

type Owner = Readonly<{
  projects: DesktopProjectExecutionConfiguration;
  authority: DesktopNativePluginAuthority;
  current(signal?: AbortSignal): void;
  actor(input: unknown): ActorContext;
}>;
/** Independent Native generation approval on the Worker's original borrowed Run store. */
export async function createNativeProjectMediaRuntime(
  owner: Owner,
  storage: DesktopProjectMaterialStorage,
  dns: NetworkDnsResolver,
): Promise<InstalledPluginProjectMediaConfig | undefined> {
  const reviews = await loadNativeProjectMediaReviews(owner);
  if (!reviews) return undefined;
  const declared = owner.projects.mediaInputs!;
  const publications = owner.projects.mediaGenerations!.publications;
  const scope = owner.authority.scope;
  const current = (actor: ActorContext) => {
    owner.current();
    owner.actor(actor);
  };
  const metadataActive = (p: ProjectMediaInputPermission) => {
    current(p.actor);
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
  const metadata = Object.freeze({
    authorize: async (p: ProjectMediaInputPermission) => {
      metadataActive(p);
      return allow();
    },
    authorizeTransaction: async (p: ProjectMediaInputPermission) => {
      metadataActive(p);
      return allow();
    },
    assertActive: metadataActive,
  });
  const verifier = createComfyUiProjectGenerationImageResultVerifier({
    identities: declared.referenceIdentities,
  });
  const sourceAdapter = createComfyUiProjectReferenceMaterialAdapter({
    identities: declared.referenceIdentities,
  });
  const hasPath = (
    paths: DesktopNativePluginAuthority["networkGrants"][number]["paths"],
    method: "GET" | "POST",
    path: string,
  ) => paths.some((p) => p.method === method && "path" in p && p.path === path);
  return Object.freeze({
    version: "crewon.project-media-worker.v1",
    reviews,
    metadataAuthorization: metadata,
    authorization: {
      authorize: async (p) => {
        current(p.actor);
        if (
          p.action !== "projectMediaRun:submit" &&
          p.action !== "projectMediaRun:observe"
        )
          denied();
        return allow();
      },
      assertActive: (p) => {
        current(p.actor);
        if (
          p.action !== "projectMediaRun:submit" &&
          p.action !== "projectMediaRun:observe"
        )
          denied();
      },
    },
    createMaterials: async ({ store, signal }) => {
      owner.current(signal);
      const clock = new SystemApplicationClock(),
        digester = new NodeSha256ContentDigester();
      const unavailable = async (): Promise<never> => denied();
      const configurations = new ExtensionConfigurationApplicationService({
        store: store.extensionStore(),
        catalog: { list: () => [], resolve: () => null },
        host: { validateConfiguration: unavailable, evaluate: unavailable },
        authorization: {
          authorize: async ({ actor, action, resource }) => {
            current(actor);
            signal.throwIfAborted();
            if (
              action !== "extension:read" ||
              resource.kind !== "extension" ||
              resource.tenantId !== scope.tenantId ||
              resource.spaceId !== scope.spaceId ||
              (!declared.referenceIdentities.some(
                (i) => i.pluginId === resource.pluginId,
              ) &&
                !publications.some((p) => p.pluginId === resource.pluginId))
            )
              denied();
            return allow();
          },
        },
        clock,
        digester,
      });
      const archive = loadDesktopProjectMaterialArchive(storage, scope);
      let adopted:
        | Awaited<ReturnType<typeof createDesktopAdoptedMediaReader>>
        | undefined;
      try {
        if (owner.projects.assetV2) {
          // Native Main starts Worker before Control. An explicit result-publish
          // grant prepares the empty shared schema before lending a read-only
          // reader; read-only grants still require an existing valid schema.
          if (owner.projects.mediaResults?.purposes.includes("publish")) {
            owner.current(signal);
            await store.extensionStore().projectMediaResults().migrate();
            owner.current(signal);
          }
          adopted = await createDesktopAdoptedMediaReader({
            store,
            storage,
            scope,
            reviews: reviews.map(({ targetIdentity, workflow }) => ({
              targetIdentity,
              workflow,
            })),
            materialArchiveId: archive.archiveId,
            clock,
            signal,
            assertCurrent: async (actor) => current(actor),
            assertActive: current,
          });
        }
        const runtime = await createProjectMediaMaterialRuntime({
          network: { dns },
          ...(adopted ? { adoptedMedia: adopted.config } : {}),
          store,
          configurations,
          clock,
          signal,
          archive,
          reviews: reviews.map(({ targetIdentity, workflow }) => ({
            targetIdentity,
            workflow,
          })),
          metadata,
          verifier,
          sourceAdapter,
          profiles: {
            resolve: async (actor) => {
              current(actor);
              return scope;
            },
          },
          projects: {
            authorize: async ({ actor, action, resource }) => {
              current(actor);
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
              current(actor);
              if (
                action !== "pluginInstallation:read" ||
                resource.kind !== "pluginInstallation" ||
                resource.tenantId !== scope.tenantId ||
                resource.spaceId !== scope.spaceId ||
                resource.profileId !== scope.profileId ||
                (resource.pluginId !== null &&
                  !publications.some(
                    (p) => p.pluginId === resource.pluginId,
                  )) ||
                (resource.packageDigest !== null &&
                  !publications.some(
                    (p) => p.packageDigest === resource.packageDigest,
                  ))
              )
                denied();
              return allow();
            },
          },
          read: {
            authorize: async ({ actor, action, resource }) => {
              current(actor);
              if (
                action !== "projectReferenceMaterial:read" ||
                new URL(resource.path, resource.origin).pathname !== "/view" ||
                !owner.authority.networkGrants.some(
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
              current(actor);
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
              current(actor);
              const request = resource.request;
              current(request.source.actor);
              if (
                request.target.profileId !== scope.profileId ||
                !publications.some(
                  (p) => p.pluginId === request.target.pluginId,
                )
              )
                denied();
              // The prepare PDP also runs inside COMMIT; only transport purposes may perform an independent read.
              if (
                action === "projectMaterial:upload" ||
                action === "projectMaterial:observe"
              ) {
                const c = await configurations.getConfiguration(actor, {
                  pluginId: request.target.pluginId,
                  revision: request.target.configurationRevision,
                });
                current(actor);
                if (
                  !c ||
                  !reviews.some(
                    (r) =>
                      r.targetIdentity.pluginId === c.pluginId &&
                      r.targetIdentity.version === c.pluginVersion &&
                      r.targetIdentity.manifestDigest === c.manifestDigest &&
                      r.targetIdentity.implementationDigest ===
                        c.implementationDigest &&
                      owner.authority.networkGrants.some(
                        (g) =>
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
            assertActive: ({ request }) => {
              current(request.source.actor);
              if (
                request.target.profileId !== scope.profileId ||
                !publications.some(
                  (p) => p.pluginId === request.target.pluginId,
                )
              )
                denied();
            },
          },
        });
        try {
          owner.current(signal);
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
  } satisfies InstalledPluginProjectMediaConfig);
}
function allow() {
  return { outcome: "allow" as const };
}
function denied(): never {
  throw new ApplicationError("authorization", "native_project_media_denied");
}
