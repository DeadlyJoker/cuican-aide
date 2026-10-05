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

export type ProjectConversationConfiguration = CreativeProjectPluginUiConfig;
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
  const configuration = captureCreativeProjectPluginUiConfig(
    input.configuration,
  );
  if (configuration === undefined) return undefined;
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
