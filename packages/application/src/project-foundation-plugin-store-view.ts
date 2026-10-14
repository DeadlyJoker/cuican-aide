import type { PluginProjectReadStoreBinding } from "./creative-project-store-port.ts";
import { ApplicationError } from "./application-error.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import type { ProjectFoundationStore } from "./project-foundation-store-port.ts";
import {
  qualifyPluginProjectFoundationScope,
  type PluginProjectFoundationScope,
} from "./plugin-project-foundation-scope.ts";
import { issueFoundationProjectReadScope } from "./plugin-project-read-scope.ts";

export function bindFoundationPluginStores(
  input: {
    projects: Pick<CreativeProjectStore, "loadProject"> &
      Partial<PluginProjectReadStoreBinding>;
    store: ProjectFoundationStore;
  },
  scope: PluginProjectFoundationScope,
) {
  qualifyPluginProjectFoundationScope(scope);
  if (!input.projects.bindProjectReads || !input.store.bindProjectReads)
    throw new ApplicationError(
      "authorization",
      "plugin_project_foundation_owned_store_required",
    );
  const readScope = issueFoundationProjectReadScope(scope);
  const projects = input.projects.bindProjectReads(readScope);
  const reads = input.store.bindProjectReads(readScope);
  const store = Object.freeze<ProjectFoundationStore>({
    ...reads,
    loadMutationReceipt: (command, options) =>
      input.store.loadMutationReceipt(command, {
        ...options,
        projectScope: scope,
      }),
    commitCreation: (command, options) =>
      input.store.commitCreation(command, { ...options, projectScope: scope }),
    commitFoundationChange: (command, options) =>
      input.store.commitFoundationChange(command, {
        ...options,
        projectScope: scope,
      }),
    commitProposal: (command, options) =>
      input.store.commitProposal(command, { ...options, projectScope: scope }),
  });
  return Object.freeze({ projects, store });
}
