import {
  ProjectMediaInputStageApplicationService,
  type ExtensionTaskApplicationService,
  type ThreadStore,
  type ContentDigester,
} from "@crewon/application";
import {
  ProjectMediaInputStageControlOwner,
  type ProjectMediaInputStageControlDependencies,
} from "./project-media-input-stage-control-owner.ts";
import type { PreparedProjectMediaInputStages } from "./project-media-input-stage-composition.ts";
/** Lends actual shared stores and task execution; no replacement conversation or private plugin runtime. */
export function createProjectMediaInputStagePluginOwner(
  input: Readonly<{
    foundation: PreparedProjectMediaInputStages;
    threadStore: Pick<ThreadStore, "loadThreadInSpace">;
    tasks: Pick<
      ExtensionTaskApplicationService,
      "createProjectMediaInputStageTurnFromHost"
    >;
    digester: ContentDigester;
    authority: Omit<
      ProjectMediaInputStageControlDependencies,
      "service" | "configuration" | "conversations"
    >;
  }>,
): ProjectMediaInputStageControlOwner {
  const f = input.foundation;
  const service = new ProjectMediaInputStageApplicationService({
    conversations: f.conversations,
    stages: f.store,
    threadStore: input.threadStore,
    projects: f.projects,
    texts: f.texts,
    authorization: f.authorization,
    tasks: input.tasks,
    digester: input.digester,
  });
  return new ProjectMediaInputStageControlOwner({
    ...input.authority,
    service,
    configuration: f.configuration,
    conversations: f.conversations,
  });
}
