import type { ActorContext } from "./authorization-port.ts";
import type {
  CreativeProjectStore,
  PluginProjectReadStoreBinding,
} from "./creative-project-store-port.ts";
import type { ListCreativeProjectsQuery } from "./creative-project-commands.ts";
import type { PluginProjectReadOptions } from "./plugin-project-read-scope.ts";
import { pluginProjectReadStore } from "./plugin-project-read-store.ts";
import {
  creativeProjectOpaqueId,
  creativeProjectTimestamp,
} from "@crewon/domain";
import {
  creativeProjectUseCase,
  creativeActor,
  creativeListQuery,
  creativeOwner,
  creativeStoredRecord,
  creativePage,
  checkedCreativeProject,
  creativeStored,
  invalidStore,
  creativeRecord,
  compareCreativeIds,
} from "./creative-project-application-support.ts";
/** Original list validation and independent policy, shared by legacy and bound reads. */
export function executeCreativeProjectList(
  dependencies: Readonly<{
    store: CreativeProjectStore & Partial<PluginProjectReadStoreBinding>;
    authorize(actor: ActorContext): Promise<void>;
  }>,
  actorInput: ActorContext,
  input: ListCreativeProjectsQuery,
  options?: PluginProjectReadOptions,
) {
  return creativeProjectUseCase(async () => {
    const actor = creativeActor(actorInput);
    const query = creativeListQuery(input);
    const readStore = pluginProjectReadStore(
      dependencies.store,
      actor,
      options,
    );
    await dependencies.authorize(actor);
    const raw = await readStore.listProjects({
      owner: creativeOwner(actor),
      ...query,
    });
    const page = creativeStoredRecord(raw, ["projects", "next"]);
    const seen = new Set<string>();
    const projects = creativePage(
      page.projects,
      query.limit,
      (item) => {
        const project = checkedCreativeProject(item, creativeOwner(actor));
        if (seen.has(project.projectId)) creativeStored(invalidStore);
        seen.add(project.projectId);
        if (
          (query.state !== "all" && project.state !== query.state) ||
          (query.after !== null && !projectBefore(project, query.after))
        )
          creativeStored(invalidStore);
        return project;
      },
      (previous, next) => projectBefore(next, previous),
    );
    const next = creativeStored(() => {
      if (page.next === null) return null;
      const cursor = creativeRecord(page.next, ["updatedAt", "projectId"]);
      const value = Object.freeze({
        updatedAt: creativeProjectTimestamp(cursor.updatedAt),
        projectId: creativeProjectOpaqueId(cursor.projectId),
      });
      const last = projects.at(-1);
      if (
        last === undefined ||
        value.updatedAt !== last.updatedAt ||
        value.projectId !== last.projectId
      )
        invalidStore();
      return value;
    });
    await dependencies.authorize(actor);
    return Object.freeze({ projects, next });
  });
}
function projectBefore(
  left: { updatedAt: string; projectId: string },
  right: { updatedAt: string; projectId: string },
): boolean {
  return (
    left.updatedAt < right.updatedAt ||
    (left.updatedAt === right.updatedAt &&
      compareCreativeIds(left.projectId, right.projectId) < 0)
  );
}
