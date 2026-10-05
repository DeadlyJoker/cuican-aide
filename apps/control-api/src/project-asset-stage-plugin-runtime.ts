import {
  ProjectAssetStageApplicationService,
  type ExtensionTaskApplicationService,
  type ThreadStore,
  type ContentDigester,
} from "@crewon/application";
import {
  ProjectAssetStageControlOwner,
  type ProjectAssetStageControlDependencies,
} from "./project-asset-stage-control-owner.ts";
import type { PreparedProjectAssetStages } from "./project-asset-stage-composition.ts";
/** Lends actual shared stores and task execution; no replacement conversation or private plugin runtime. */
export function createProjectAssetStagePluginOwner(
  input: Readonly<{
    foundation: PreparedProjectAssetStages;
    threadStore: Pick<ThreadStore, "loadThreadInSpace">;
    tasks: Pick<
      ExtensionTaskApplicationService,
      "createProjectAssetStageTurnFromHost"
    >;
    digester: ContentDigester;
    authority: Omit<
      ProjectAssetStageControlDependencies,
      "service" | "configuration" | "conversations"
    >;
  }>,
): ProjectAssetStageControlOwner {
  const f = input.foundation;
  const service = new ProjectAssetStageApplicationService({
    conversations: f.conversations,
    stages: f.store,
    threadStore: input.threadStore,
    projects: f.projects,
    texts: f.texts,
    authorization: f.authorization,
    tasks: input.tasks,
    digester: input.digester,
  });
  return new ProjectAssetStageControlOwner({
    ...input.authority,
    service,
    configuration: f.configuration,
    conversations: f.conversations,
  });
}
