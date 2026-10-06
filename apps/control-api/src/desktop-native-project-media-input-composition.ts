import {
  ApplicationError,
  type ActorContext,
  type ProjectMediaInputPermission,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { assertDesktopPluginConfigurationFileCurrent } from "./desktop-plugin-configuration.ts";
import {
  assertDesktopNativePluginControlConfigCurrent,
  type DesktopNativePluginControlConfig,
} from "./desktop-native-plugin-control-environment.ts";
import { createComfyUiProjectGenerationImageResultVerifier } from "./comfyui-image-result-verifier.ts";
import {
  captureInstalledProjectMediaInputConfiguration,
  type InstalledProjectMediaInputConfiguration,
} from "./installed-project-media-input-configuration.ts";

type DeclarationInput = Readonly<{
  configuration: DesktopPluginConfiguration;
  nativeControl: DesktopNativePluginControlConfig;
}>;
/** This is an independent metadata grant, not an extension of media execution approval. */
export function assertDesktopNativeProjectMediaInputDeclaration(
  input: DeclarationInput,
): void {
  const declared = declaration(input.configuration);
  if (declared === undefined) return;
  assertDesktopPluginConfigurationFileCurrent(input.configuration);
  assertDesktopNativePluginControlConfigCurrent(input.nativeControl);
  for (const review of declared.reviews) {
    const identity = review.targetIdentity;
    if (
      !input.nativeControl.authority.packages.some((pkg) =>
        ["pluginId", "publisherId", "version", "packageDigest"].every(
          (key) =>
            pkg[key as keyof typeof pkg] ===
            identity[key as keyof typeof identity],
        ),
      )
    )
      invalid();
    // A disabled approved package need not be prepared. A prepared identity must agree in full.
    for (const entry of input.nativeControl.publication.entries) {
      if (
        entry.identity.pluginId === identity.pluginId &&
        entry.identity.packageDigest === identity.packageDigest &&
        extensionCanonicalJson(entry.identity) !==
          extensionCanonicalJson(identity)
      )
        invalid();
    }
  }
  assertDesktopNativePluginControlConfigCurrent(input.nativeControl);
}

/** Invoked by the genuine Native task authority with its original request and commit hooks. */
export function composeDesktopNativeProjectMediaInputConfiguration(
  input: DeclarationInput &
    Readonly<{
      assertRequestCurrent(actor: ActorContext): Promise<void>;
      assertTransactionCurrent(actor: ActorContext): void;
    }>,
): InstalledProjectMediaInputConfiguration | undefined {
  assertDesktopNativeProjectMediaInputDeclaration(input);
  const declared = declaration(input.configuration);
  if (declared === undefined) return undefined;
  const scope = input.configuration.scope;
  const current = async (actor: ActorContext) => {
    await input.assertRequestCurrent(actor);
    assertDesktopNativeProjectMediaInputDeclaration(input);
    input.assertTransactionCurrent(actor);
  };
  const allowed = (p: ProjectMediaInputPermission) =>
    (p.action === "projectMediaInput:read" &&
      declared.purposes.includes("read")) ||
    (p.action === "projectMediaInput:write" &&
      declared.purposes.includes("write"));
  const active = (p: ProjectMediaInputPermission) => {
    input.assertTransactionCurrent(p.actor);
    assertDesktopNativeProjectMediaInputDeclaration(input);
    if (
      !allowed(p) ||
      typeof p.resource.projectId !== "string" ||
      (p.resource.command !== null &&
        (p.resource.command.projectId !== p.resource.projectId ||
          p.resource.command.target.pluginId !== "crewon.short-drama" ||
          p.resource.command.target.profileId !== scope.profileId))
    )
      denied();
    input.assertTransactionCurrent(p.actor);
  };
  return captureInstalledProjectMediaInputConfiguration({
    version: "crewon.project-media-input-control.v1",
    reviews: declared.reviews,
    authorization: {
      authorize: async (p: ProjectMediaInputPermission) => {
        await current(p.actor);
        active(p);
        return { outcome: "allow" as const };
      },
      assertActive: active,
    },
    projects: {
      authorize: async ({ actor, action, resource }) => {
        await current(actor);
        return action === "creativeProject:read" &&
          resource.kind === "creativeProject" &&
          resource.tenantId === scope.tenantId &&
          resource.spaceId === scope.spaceId &&
          resource.projectId !== null
          ? { outcome: "allow" as const }
          : reject();
      },
    },
    installations: {
      authorize: async ({ actor, action, resource }) => {
        await current(actor);
        return action === "pluginInstallation:read" &&
          resource.kind === "pluginInstallation" &&
          resource.tenantId === scope.tenantId &&
          resource.spaceId === scope.spaceId &&
          resource.profileId === scope.profileId &&
          resource.pluginId === "crewon.short-drama" &&
          (resource.packageDigest === null ||
            declared.reviews.some(
              (r) => r.targetIdentity.packageDigest === resource.packageDigest,
            ))
          ? { outcome: "allow" as const }
          : reject();
      },
    },
    verifier: createComfyUiProjectGenerationImageResultVerifier({
      identities: declared.referenceIdentities,
    }),
  } satisfies InstalledProjectMediaInputConfiguration);
}
function declaration(configuration: DesktopPluginConfiguration) {
  return configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
    ? configuration.projects.mediaInputs
    : undefined;
}
function reject() {
  return {
    outcome: "deny" as const,
    reasonCode: "desktop_native_project_media_input_denied",
  };
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_native_project_media_input_denied",
  );
}
function invalid(): never {
  throw new Error("desktop_native_project_media_input_declaration_invalid");
}
