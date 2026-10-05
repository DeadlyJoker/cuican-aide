import {
  ProjectTextPlanApplicationService,
  type CreativeProjectAuthorizationPort,
  type CreativeProjectStore,
  type ExtensionStore,
  type ProjectTextPlanStore,
  type ProjectTextStore,
} from "@crewon/application";
import type { PreparedProjectConversations } from "./project-conversation-composition.ts";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import {
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
  NodeSha256ContentDigester,
} from "./standalone-adapters.ts";

export type PreparedProjectTextPlans = Readonly<{
  configuration: CreativeProjectPluginUiConfig;
  store: ProjectTextPlanStore;
  service: ProjectTextPlanApplicationService;
  conversations: PreparedProjectConversations;
  projects: CreativeProjectStore;
  texts: ProjectTextStore;
  authorization: CreativeProjectAuthorizationPort;
}>;

export function captureProjectTextPlanConfiguration(
  input: unknown,
  prerequisites: Readonly<{
    projects: CreativeProjectPluginUiConfig | undefined;
    texts: CreativeProjectPluginUiConfig | undefined;
    conversations: CreativeProjectPluginUiConfig | undefined;
  }>,
): CreativeProjectPluginUiConfig | undefined {
  const configuration = captureCreativeProjectPluginUiConfig(input);
  if (configuration === undefined) return undefined;
  if (
    Object.values(prerequisites).some(
      (required) =>
        required === undefined ||
        configuration.publications.some(
          (p) =>
            !required.publications.some(
              (q) =>
                p.pluginId === q.pluginId &&
                p.packageDigest === q.packageDigest &&
                p.contributionId === q.contributionId,
            ),
        ),
    )
  )
    throw new Error("project_text_plan_publication_prerequisites_required");
  return configuration;
}

/** Only the independently approved plan publication opens this additive schema. */
export async function prepareProjectTextPlans(
  owner: Readonly<{
    projectTextPlanStore?(): ProjectTextPlanStore;
    extensionStore?(): ExtensionStore;
  }>,
  input: Readonly<{
    configuration: CreativeProjectPluginUiConfig | undefined;
    conversations: PreparedProjectConversations | undefined;
  }>,
): Promise<PreparedProjectTextPlans | undefined> {
  const configuration = captureCreativeProjectPluginUiConfig(
    input.configuration,
  );
  if (configuration === undefined) return undefined;
  const conversations = input.conversations;
  if (
    conversations === undefined ||
    owner.projectTextPlanStore === undefined ||
    owner.extensionStore === undefined
  )
    throw new Error("project_text_plan_composition_required");
  const store = owner.projectTextPlanStore();
  await store.migrate();
  const service = new ProjectTextPlanApplicationService({
    plans: store,
    conversations: conversations.store,
    projects: conversations.projects,
    texts: conversations.texts,
    extensions: owner.extensionStore(),
    authorization: conversations.authorization,
    clock: new SystemApplicationClock(),
    ids: new UuidV7ApplicationIdGenerator(),
    digester: new NodeSha256ContentDigester(),
  });
  return Object.freeze({
    configuration,
    store,
    service,
    conversations,
    projects: conversations.projects,
    texts: conversations.texts,
    authorization: conversations.authorization,
  });
}
