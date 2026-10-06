import { SqliteRunStore, PostgresDomainStore } from "@crewon/store";
import type {
  CreativeProjectAuthorizationPort,
  CreativeProjectStore,
  ProjectTextStore,
  ProjectMediaInputStageStore,
  ProjectConversationStore,
} from "@crewon/application";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";
export type ProjectMediaInputStageConfiguration =
  CreativeProjectPluginUiConfig &
    Readonly<{ version: "crewon.project-media-input-stages.v1" }>;
/** Independent Composer opt-in. Existing text/asset grants never implicitly enable media preparation. */
export function captureProjectMediaInputStageConfiguration(
  input: unknown,
  conversations: CreativeProjectPluginUiConfig | undefined,
): ProjectMediaInputStageConfiguration | undefined {
  if (input === undefined) return undefined;
  const value = pluginSecurityRecord(input, ["version", "publications"]);
  if (value.version !== "crewon.project-media-input-stages.v1")
    throw new Error("project_media_input_stage_configuration_invalid");
  const grant = captureCreativeProjectPluginUiConfig({
    publications: value.publications,
  });
  if (
    grant === undefined ||
    grant.publications.some(
      (p) =>
        !conversations?.publications.some(
          (c) =>
            c.pluginId === p.pluginId &&
            c.packageDigest === p.packageDigest &&
            c.contributionId === p.contributionId,
        ),
    )
  )
    throw new Error("project_media_input_stage_publication_required");
  return Object.freeze({
    version: "crewon.project-media-input-stages.v1",
    publications: grant.publications,
  });
}
export type PreparedProjectMediaInputStages = Readonly<{
  configuration: ProjectMediaInputStageConfiguration;
  store: ProjectMediaInputStageStore;
  conversations: ProjectConversationStore;
  projects: CreativeProjectStore;
  texts: ProjectTextStore;
  authorization: CreativeProjectAuthorizationPort;
}>;
/** Disabled media input stages acquire no adapter and imply no execution grant from the existing conversation opt-in. */
export async function prepareProjectMediaInputStages(
  owner: Readonly<{
    projectMediaInputStageStore?(): ProjectMediaInputStageStore;
  }>,
  input: Readonly<{
    configuration: ProjectMediaInputStageConfiguration | undefined;
    conversations: ProjectConversationStore | undefined;
    projects: CreativeProjectStore;
    texts: ProjectTextStore | undefined;
    authorization: CreativeProjectAuthorizationPort;
  }>,
): Promise<PreparedProjectMediaInputStages | undefined> {
  if (input.configuration === undefined) return undefined;
  if (
    owner.projectMediaInputStageStore === undefined ||
    input.conversations === undefined ||
    input.texts === undefined
  )
    throw new Error("project_media_input_stage_composition_required");
  if (
    !(owner instanceof SqliteRunStore) &&
    !(owner instanceof PostgresDomainStore)
  )
    throw new Error("project_media_input_stage_parent_required");
  // Stage migration precedes TaskCore startup. Establish its actual parent's prerequisite metadata only;
  // this does not deploy the asset writer, media-input verifier, provider I/O or execution permission.
  const assets = owner.projectAssetStore();
  await assets.migrate();
  await assets.projectMediaInputStore().migrate();
  const store = owner.projectMediaInputStageStore();
  if (store.version !== "crewon.project-media-input-stage-run-admission.v1")
    throw new Error("project_media_input_stage_store_required");
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
