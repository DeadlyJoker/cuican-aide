import { pluginSecurityRecord } from "./plugin-security-validation.ts";
import type {
  CreativeProjectAuthorizationPort,
  CreativeProjectStore,
  ProjectConversationStore,
  ProjectTextStore,
} from "@crewon/application";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";

export type ProjectConversationConfiguration = CreativeProjectPluginUiConfig &
  Readonly<{ projectOwnership?: "plugin-project-v1" }>;

/** Explicit trusted deployment mode; never inferred from a module declaration or caller project ID. */
export function captureProjectConversationConfiguration(
  input: unknown,
): ProjectConversationConfiguration | undefined {
  if (input === undefined) return undefined;
  const value = pluginSecurityRecord(input, [
    "publications",
    ...(Object.hasOwn(input as object, "projectOwnership")
      ? ["projectOwnership"]
      : []),
  ]);
  if (
    Object.hasOwn(value, "projectOwnership") &&
    value.projectOwnership !== "plugin-project-v1"
  )
    throw new Error("project_conversation_project_ownership_invalid");
  const original = captureCreativeProjectPluginUiConfig({
    publications: value.publications,
  })!;
  return Object.freeze({
    ...original,
    ...(value.projectOwnership === undefined
      ? {}
      : { projectOwnership: "plugin-project-v1" as const }),
  });
}
export type PreparedProjectConversations = Readonly<{
  configuration: ProjectConversationConfiguration;
  store: ProjectConversationStore;
  projects: CreativeProjectStore;
  texts: ProjectTextStore;
  authorization: CreativeProjectAuthorizationPort;
}>;

/** Only explicit publications open this independent schema. A declaration is not Run authority. */
export async function prepareProjectConversations(
  owner: Readonly<{
    projectConversationStore?(): ProjectConversationStore;
    pluginInstallationStore?(): { migrate(): Promise<void> };
    extensionStore?(): {
      migrate(): Promise<void>;
      migratePluginAdmissions(): Promise<void>;
    };
  }>,
  input: Readonly<{
    configuration: ProjectConversationConfiguration | undefined;
    projects: CreativeProjectStore;
    texts: ProjectTextStore | undefined;
    authorization: CreativeProjectAuthorizationPort;
  }>,
): Promise<PreparedProjectConversations | undefined> {
  const configuration = captureProjectConversationConfiguration(
    input.configuration,
  );
  if (configuration === undefined) return undefined;
  if (configuration.projectOwnership === "plugin-project-v1")
    assertQualifiedProjectReader(input.projects);
  if (owner.projectConversationStore === undefined || input.texts === undefined)
    throw new Error("project_conversation_composition_required");
  if (
    owner.extensionStore === undefined ||
    owner.pluginInstallationStore === undefined
  )
    throw new Error("project_conversation_admissions_required");
  await owner.pluginInstallationStore().migrate();
  await owner.extensionStore().migrate();
  await owner.extensionStore().migratePluginAdmissions();
  const store = owner.projectConversationStore();
  await store.migrate();
  return Object.freeze({
    configuration,
    store,
    projects: input.projects,
    texts: input.texts,
    authorization: input.authorization,
  });
}

/** Feature readiness only. The original bound Store still verifies each genuine scope and SQL snapshot. */
function assertQualifiedProjectReader(projects: CreativeProjectStore): void {
  for (
    let owner: object | null = projects, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(
      owner,
      "bindProjectReads",
    );
    if (descriptor === undefined) continue;
    if (
      Object.hasOwn(descriptor, "value") &&
      typeof descriptor.value === "function"
    )
      return;
    break;
  }
  throw new Error("plugin_project_read_store_unavailable");
}
