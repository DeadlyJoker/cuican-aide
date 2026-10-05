import type {
  CreativeProjectAuthorizationPort,
  CreativeProjectStore,
  ProjectTextStore,
  ProjectAssetStageStore,
  ProjectConversationStore,
} from "@crewon/application";
import type { ProjectAssetCompositionConfig } from "./project-asset-composition.ts";
export type PreparedProjectAssetStages = Readonly<{
  configuration: NonNullable<ProjectAssetCompositionConfig["assetStages"]>;
  store: ProjectAssetStageStore;
  conversations: ProjectConversationStore;
  projects: CreativeProjectStore;
  texts: ProjectTextStore;
  authorization: CreativeProjectAuthorizationPort;
}>;
/** Disabled asset stages acquire no adapter and imply no execution grant from the existing conversation opt-in. */
export async function prepareProjectAssetStages(
  owner: Readonly<{ projectAssetStageStore?(): ProjectAssetStageStore }>,
  input: Readonly<{
    configuration: ProjectAssetCompositionConfig["assetStages"];
    conversations: ProjectConversationStore | undefined;
    projects: CreativeProjectStore;
    texts: ProjectTextStore | undefined;
    authorization: CreativeProjectAuthorizationPort;
  }>,
): Promise<PreparedProjectAssetStages | undefined> {
  if (input.configuration === undefined) return undefined;
  if (
    owner.projectAssetStageStore === undefined ||
    input.conversations === undefined ||
    input.texts === undefined
  )
    throw new Error("project_asset_stage_composition_required");
  const store = owner.projectAssetStageStore();
  if (store.version !== "crewon.project-asset-stage-run-admission.v1")
    throw new Error("project_asset_stage_store_required");
  await store.migrate();
  return Object.freeze({
    configuration: input.configuration,
    store,
    conversations: input.conversations,
    projects: input.projects,
    texts: input.texts,
    authorization: input.authorization,
  });
}
