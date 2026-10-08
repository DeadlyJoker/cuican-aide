import {
  ApplicationError,
  captureSourceUploadPermission,
  type ActorContext,
  type ProjectSourceUploadAuthorizationPort,
  type ProjectSourceUploadPermission,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  assertDesktopPluginConfigurationFileCurrent,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import {
  captureProjectFoundationCompositionConfig,
  type ProjectFoundationCompositionConfig,
} from "./project-foundation-composition.ts";
import type { CreativeProjectCompositionConfig } from "./creative-project-composition.ts";

const issued = new WeakMap<object, DesktopPluginConfiguration>();
const actions = new Set([
  "projectSourceUpload:begin",
  "projectSourceUpload:write",
  "projectSourceUpload:status",
  "projectSourceUpload:prepare",
  "projectSourceUpload:cancel",
  "projectSourceUpload:adopt",
]);

/** Independent Native business policy from the original current private opt-in, never renderer JSON. */
class DesktopProjectSourceUploadAuthorization
  implements ProjectSourceUploadAuthorizationPort
{
  readonly #configuration: DesktopPluginConfiguration;
  constructor(configuration: DesktopPluginConfiguration) {
    this.#configuration = configuration;
    Object.freeze(this);
  }
  assertActive(input: ProjectSourceUploadPermission): void {
    const permission = captureSourceUploadPermission(input),
      configuration = this.#configuration;
    assertDesktopPluginConfigurationFileCurrent(configuration);
    if (
      configuration.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3" ||
      configuration.projectFoundation === undefined ||
      extensionCanonicalJson(permission.actor) !==
        extensionCanonicalJson(configuration.actor) ||
      permission.resource.owner.tenantId !== configuration.scope.tenantId ||
      permission.resource.owner.spaceId !== configuration.scope.spaceId ||
      permission.resource.owner.principalId !==
        configuration.actor.principalId ||
      !actions.has(permission.action)
    )
      throw new ApplicationError(
        "authorization",
        "desktop_project_source_upload_denied",
      );
  }
  async authorize(permission: ProjectSourceUploadPermission) {
    try {
      this.assertActive(permission);
      return { outcome: "allow" as const };
    } catch {
      return {
        outcome: "deny" as const,
        reasonCode: "desktop_project_source_upload_denied",
      };
    }
  }
}

export function composeDesktopProjectFoundationStartup(
  configuration: DesktopPluginConfiguration,
  actor: ActorContext,
): ProjectFoundationCompositionConfig | undefined {
  if (
    configuration.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3" ||
    configuration.projectFoundation === undefined
  )
    return undefined;
  assertDesktopPluginConfigurationFileCurrent(configuration);
  if (
    extensionCanonicalJson(actor) !==
    extensionCanonicalJson(configuration.actor)
  )
    throw new Error("desktop_plugin_owner_mismatch");
  return captureProjectFoundationCompositionConfig({
    ...configuration.projectFoundation,
    uploads: {
      ...configuration.projectFoundation.uploads,
      authorization: new DesktopProjectSourceUploadAuthorization(configuration),
    },
  });
}

/** Issue only the final original startup object, after the old execution branch has captured its ports. */
export function issueDesktopProjectFoundationStartup(
  configuration: DesktopPluginConfiguration,
  projects: CreativeProjectCompositionConfig,
): void {
  if (projects.foundation === undefined) return;
  assertDeclaration(configuration, projects);
  issued.set(projects, configuration);
}

/** A copied startup/PDP object or a different private file cannot acquire the new schema or service. */
export function assertDesktopProjectFoundationStartupBinding(
  configuration: DesktopPluginConfiguration,
  projects: CreativeProjectCompositionConfig | undefined,
): void {
  const declared =
    configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
      ? configuration.projectFoundation
      : undefined;
  if (declared === undefined && projects?.foundation === undefined) return;
  if (projects === undefined || issued.get(projects) !== configuration)
    throw new Error("desktop_project_foundation_startup_authority_required");
  assertDeclaration(configuration, projects);
}
function assertDeclaration(
  configuration: DesktopPluginConfiguration,
  projects: CreativeProjectCompositionConfig,
): void {
  assertDesktopPluginConfigurationFileCurrent(configuration);
  if (
    configuration.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3" ||
    configuration.projectFoundation === undefined ||
    projects.foundation === undefined
  )
    throw new Error("desktop_project_foundation_startup_authority_required");
  const foundation = projects.foundation;
  const actual = {
    version: foundation.version,
    ...(foundation.pluginUi === undefined
      ? {}
      : { pluginUi: foundation.pluginUi }),
    uploads: {
      version: foundation.uploads.version,
      ...(foundation.uploads.pluginUi === undefined
        ? {}
        : { pluginUi: foundation.uploads.pluginUi }),
    },
  };
  if (
    extensionCanonicalJson(actual) !==
    extensionCanonicalJson(configuration.projectFoundation)
  )
    throw new Error("desktop_project_foundation_startup_authority_required");
}
