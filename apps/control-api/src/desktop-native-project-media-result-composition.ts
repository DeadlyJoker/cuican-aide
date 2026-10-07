import {
  ApplicationError,
  mediaInputSame,
  type ActorContext,
  type ApplicationClock,
  type ProjectMediaResultPermission,
  type ProjectMediaResultCatalogPermission,
} from "@crewon/application";
import { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";
import { loadDesktopProjectResultArchive } from "@crewon/media-runtime/desktop-project-result-archive";
import type { DesktopProjectMaterialStorage } from "@crewon/media-runtime/desktop-project-material-archive";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopNativePluginControlConfig } from "./desktop-native-plugin-control-environment.ts";
import { assertDesktopNativeProjectMediaInputDeclaration } from "./desktop-native-project-media-input-composition.ts";
import type { InstalledProjectMediaResultConfiguration } from "./installed-project-media-result-runtime.ts";

export function composeDesktopNativeProjectMediaResultConfiguration(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    nativeControl: DesktopNativePluginControlConfig;
    storage?: DesktopProjectMaterialStorage;
    clock: ApplicationClock;
    assertRequestCurrent(actor: ActorContext): Promise<void>;
    assertTransactionCurrent(actor: ActorContext): void;
  }>,
): InstalledProjectMediaResultConfiguration | undefined {
  if (
    input.configuration.schemaVersion !==
      "crewon.desktop-plugin-bootstrap.v3" ||
    input.configuration.projects.mediaResults === undefined
  )
    return undefined;
  assertDesktopNativeProjectMediaInputDeclaration(input);
  if (!input.storage)
    throw new Error("desktop_native_project_result_storage_required");
  const declared = input.configuration.projects.mediaResults,
    scope = input.configuration.scope,
    storage = Object.freeze({ ...input.storage });
  const reviews = input.configuration.projects.mediaInputs!.reviews.filter(
    (r) =>
      declared.publications.some(
        (p) =>
          p.pluginId === r.targetIdentity.pluginId &&
          p.packageDigest === r.targetIdentity.packageDigest,
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
  const resultActive = (p: ProjectMediaResultPermission) => {
    active(p.actor);
    if (
      !(
        (p.action === "projectMediaResult:read" &&
          declared.purposes.includes("read")) ||
        (p.action === "projectMediaResult:publish" &&
          declared.purposes.includes("publish"))
      )
    )
      denied();
  };
  const catalogActive = (p: ProjectMediaResultCatalogPermission) => {
    active(p.actor);
    if (
      p.action !== "projectMediaResult:list" ||
      !declared.purposes.includes("read")
    )
      denied();
  };
  return Object.freeze({
    version: "crewon.project-media-results-control.v1",
    profileId: scope.profileId,
    purposes: declared.purposes,
    reviews,
    clock: input.clock,
    authorization: {
      authorize: async (p) => {
        await current(p.actor);
        resultActive(p);
        return { outcome: "allow" as const };
      },
      assertActive: resultActive,
    },
    catalogAuthorization: {
      authorize: async (p) => {
        await current(p.actor);
        catalogActive(p);
        return { outcome: "allow" as const };
      },
      assertActive: catalogActive,
    },
    outputApproval: {
      assertCurrent: async ({ actor, source, signal }) => {
        signal.throwIfAborted();
        await current(actor);
        const target = source.targetIdentity;
        if (
          !declared.purposes.includes("publish") ||
          !reviews.some(
            (r) =>
              mediaInputSame(r.targetIdentity, target) &&
              mediaInputSame(r.workflow, source.workflow),
          ) ||
          !input.nativeControl.authority.networkGrants.some(
            (g) =>
              g.pluginId === target.pluginId &&
              g.publisherId === target.publisherId &&
              g.version === target.version &&
              g.packageDigest === target.packageDigest &&
              g.baseUrlParameter === "baseUrl" &&
              g.baseUrl === source.configuration.origin &&
              g.paths.some(
                (p) => p.method === "GET" && "path" in p && p.path === "/view",
              ),
          )
        )
          denied();
        signal.throwIfAborted();
        active(actor);
      },
    },
    createArchive: () => {
      assertDesktopNativeProjectMediaInputDeclaration(input);
      const config = loadDesktopProjectResultArchive(storage, scope);
      try {
        return new FilesystemProjectMediaResultArchive(config);
      } finally {
        config.encryptionKey.fill(0);
      }
    },
  } satisfies InstalledProjectMediaResultConfiguration);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_native_project_media_result_denied",
  );
}
