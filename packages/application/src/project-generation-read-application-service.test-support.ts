import type { RunState } from "@crewon/domain";
import { CreativeProjectApplicationService } from "./creative-project-application-service.ts";
import { ExtensionReadApplicationService } from "./extension-read-application-service.ts";
import { ProjectGenerationReadApplicationService } from "./project-generation-read-application-service.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import { projectTaskFixture } from "./project-generation-task.test-support.ts";
import {
  taskActor,
  taskDigester,
} from "./extension-plugin-task.test-support.ts";

/** Actual Application services with memory ports; SQL proof lives in the Store integration suite. */
export async function projectGenerationReadFixture(
  options: { generated?: boolean } = {},
) {
  const f = projectTaskFixture();
  const generated = options.generated === false ? null : await f.generate();
  const state = {
    run: generated?.run.state ?? (null as RunState | null),
    linkReads: 0,
    runReads: 0,
    operationReads: 0,
    activationState: "enabled" as "enabled" | "disabled" | "revoked",
    beforeLink: null as (() => void | Promise<void>) | null,
    beforeOperations: null as ((count: number) => void | Promise<void>) | null,
    returnedLink: undefined as unknown,
    missingReceipt: false,
    beforeReceipt: null as (() => void | Promise<void>) | null,
  };
  const extensions: ExtensionStore = {
    ...f.extensions,
    projectGenerationReadVersion: "crewon.project-generation-read.v1",
    async loadProjectGenerationLinkBySource(input) {
      state.linkReads++;
      await state.beforeLink?.();
      if (state.returnedLink !== undefined)
        return state.returnedLink as Awaited<
          ReturnType<
            NonNullable<ExtensionStore["loadProjectGenerationLinkBySource"]>
          >
        >;
      return structuredClone(
        Array.from(f.state.links.values()).find(
          (link) =>
            link.tenantId === input.owner.tenantId &&
            link.spaceId === input.owner.spaceId &&
            link.ownerPrincipalId === input.owner.principalId &&
            link.projectId === input.projectId &&
            link.reference.assetId === input.assetId &&
            link.reference.assetRevision === input.assetRevision,
        ) ?? null,
      );
    },
    async loadExtensionRunBinding(input) {
      return structuredClone(f.state.links.get(input.runId)?.binding ?? null);
    },
    async loadExtensionActivation(input) {
      const value = await f.extensions.loadExtensionActivation(input);
      return value === null ? null : { ...value, state: state.activationState };
    },
    async loadExtensionTurnReceipt(input) {
      await state.beforeReceipt?.();
      return state.missingReceipt
        ? null
        : f.extensions.loadExtensionTurnReceipt(input);
    },
  };
  const projects = new CreativeProjectApplicationService({
    ...f.projects,
    clock: f.base.dependencies.clock,
    ids: f.base.dependencies.ids,
    digester: taskDigester,
  });
  const tasks = new ExtensionReadApplicationService({
    ...f.base.dependencies,
    extensions,
    runs: {
      async loadRunInSpace(input) {
        state.runReads++;
        return state.run?.tenantId === input.tenantId &&
          state.run.spaceId === input.spaceId &&
          state.run.runId === input.runId
          ? structuredClone(state.run)
          : null;
      },
    },
    agentVersions: {
      async loadAgentVersion() {
        throw new Error("read_must_not_prepare_execution");
      },
      async loadAgentVersionDeployment() {
        throw new Error("read_must_not_prepare_execution");
      },
    },
    operations: {
      async loadExternalOperation() {
        return null;
      },
      async listExternalOperations() {
        state.operationReads++;
        await state.beforeOperations?.(state.operationReads);
        return { operations: [], truncated: false };
      },
    },
    host: {
      async validateConfiguration() {
        throw new Error("read_must_not_prepare_execution");
      },
      async evaluate() {
        throw new Error("read_must_not_prepare_execution");
      },
    },
  });
  const dependencies = { projects, tasks, extensions, digester: taskDigester };
  const service = new ProjectGenerationReadApplicationService(dependencies);
  const query = {
    projectId: f.reference.projectId,
    assetId: f.reference.assetId,
    assetRevision: f.reference.assetRevision,
  };
  return {
    f,
    state,
    generated,
    projects,
    tasks,
    extensions,
    dependencies,
    service,
    query,
    read: () => service.getConceptGeneration(taskActor, query),
  };
}
