import {
  appendConceptAssetRevision,
  appendProjectBriefRevision,
  createConceptAsset,
  createCreativeProject,
  createProjectGenerationLink,
  setCreativeProjectState,
  type ConceptAssetRevision,
  type ProjectBriefRevision,
  type ProjectGenerationLink,
  type ProjectGenerationReference,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectStore,
} from "./creative-project-store-port.ts";
import type {
  CommitExtensionTurnOptions,
  ExtensionStore,
} from "./extension-store-port.ts";
import {
  pluginTaskFixture,
  taskActor,
  taskCommand,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";

const at = "2026-10-02T00:00:00.000Z";
const scope = {
  tenantId: taskActor.tenantId,
  spaceId: taskActor.spaceId,
  projectId: "project/概念",
};

/** Application-only doubles. No SQL transaction, actual Worker, vendor or pricing policy is demonstrated. */
export function projectTaskFixture() {
  const base = pluginTaskFixture();
  const created = createCreativeProject({
    scope,
    actor: taskActor,
    title: "保存的故事",
    at,
  });
  const initial = appendProjectBriefRevision(
    {
      project: created,
      actor: taskActor,
      expectedProjectRevision: created.revision,
      text: " 保存的需求\n 原文 ",
      at,
    },
    taskDigester,
  );
  const concept = createConceptAsset(
    {
      project: initial.project,
      actor: taskActor,
      expectedProjectRevision: initial.project.revision,
      brief: initial.brief,
      assetId: "asset/稳定%身份",
      name: "街角",
      prompt: " 已保存街角\n保留首尾空格 ",
      at,
    },
    taskDigester,
  );
  const state = {
    project: concept.project,
    asset: concept.asset,
    revisions: new Map<number, ConceptAssetRevision>([
      [1, concept.assetRevision],
    ]),
    briefs: new Map<number, ProjectBriefRevision>([[1, initial.brief]]),
    links: new Map<string, ProjectGenerationLink>(),
    projectReads: [] as Array<{ method: string; input: unknown }>,
    projectPermissions: [] as string[],
    deniedProject: false,
    hostAlive: true,
    currentChecks: 0,
    activeChecks: 0,
    receiverChecks: 0,
    linkReads: 0,
    commitOptions: [] as Array<CommitExtensionTurnOptions | undefined>,
    guardedProjectReadCounts: [] as Array<readonly [number, number]>,
    afterConfirmedCommit: null as (() => void) | null,
  };
  const reference: ProjectGenerationReference = Object.freeze({
    projectId: scope.projectId,
    assetId: concept.asset.assetId,
    assetRevision: 1,
    expectedProjectRevision: concept.project.revision,
    expectedAssetMetadataRevision: concept.asset.revision,
  });
  const command = {
    ...taskCommand,
    intent: {
      kind: "generate" as const,
      input: { prompt: concept.assetRevision.prompt },
    },
  };
  const assertOwner = (input: {
    owner: { principalId: string; tenantId: string; spaceId: string };
    projectId: string;
  }) => {
    return (
      input.owner.principalId === state.project.ownerPrincipalId &&
      input.owner.tenantId === state.project.tenantId &&
      input.owner.spaceId === state.project.spaceId &&
      input.projectId === state.project.projectId
    );
  };
  const read = <T>(method: string, input: unknown, value: T): Promise<T> => {
    state.projectReads.push({ method, input: structuredClone(input) });
    return Promise.resolve(structuredClone(value));
  };
  const unused = async (): Promise<never> => {
    throw new Error("project-generation-must-not-edit-source");
  };
  const store: CreativeProjectStore = {
    loadProject: (input) =>
      read("loadProject", input, assertOwner(input) ? state.project : null),
    loadConceptAsset: (input) =>
      read(
        "loadConceptAsset",
        input,
        assertOwner(input) && input.assetId === state.asset.assetId
          ? state.asset
          : null,
      ),
    loadConceptRevision: (input) =>
      read(
        "loadConceptRevision",
        input,
        assertOwner(input) && input.assetId === state.asset.assetId
          ? (state.revisions.get(input.assetRevision) ?? null)
          : null,
      ),
    loadBrief: (input) =>
      read(
        "loadBrief",
        input,
        assertOwner(input)
          ? (state.briefs.get(input.briefRevision) ?? null)
          : null,
      ),
    listProjects: unused,
    listBriefs: unused,
    listConceptAssets: unused,
    listConceptRevisions: unused,
    loadMutationReceipt: unused,
    commitProjectCreation: unused,
    commitProjectMetadata: unused,
    commitProjectBrief: unused,
    commitConceptRevision: unused,
  };
  const authority: CreativeProjectCommitAuthority = {
    async assertCurrent() {
      if (this !== authority) throw new Error("authority_receiver_lost");
      state.receiverChecks++;
      state.currentChecks++;
      if (!state.hostAlive)
        throw new ApplicationError("authorization", "project_host_withdrawn");
    },
    assertActive() {
      if (this !== authority) throw new Error("authority_receiver_lost");
      state.receiverChecks++;
      state.activeChecks++;
      if (!state.hostAlive)
        throw new ApplicationError("authorization", "project_host_withdrawn");
    },
  };
  const extensions: ExtensionStore = {
    ...base.extensions,
    projectGenerationVersion: "crewon.project-generation-link.v0",
    async loadProjectGenerationLink(input) {
      state.linkReads++;
      const link = state.links.get(input.runId);
      return structuredClone(
        link &&
          link.tenantId === input.tenantId &&
          link.spaceId === input.spaceId
          ? link
          : null,
      );
    },
    async commitExtensionTurn(input, options) {
      state.commitOptions.push(options);
      const readsBeforeGuard = state.projectReads.length;
      await options?.projectGenerationAuthority?.assertCurrent();
      options?.projectGenerationAuthority?.assertActive();
      state.guardedProjectReadCounts.push([
        readsBeforeGuard,
        state.projectReads.length,
      ]);
      const ref = input.projectGeneration;
      const revision =
        ref === undefined ? null : state.revisions.get(ref.assetRevision)!;
      const link =
        ref === undefined
          ? null
          : createProjectGenerationLink(
              {
                actor: taskActor,
                reference: ref,
                project: state.project,
                asset: state.asset,
                assetRevision: revision!,
                brief: state.briefs.get(revision!.briefRevision)!,
                binding: input.binding,
                receipt: input.receipt,
                at,
              },
              taskDigester,
            );
      const result = await base.extensions.commitExtensionTurn(input);
      if (link !== null) state.links.set(result.binding.runId, link);
      state.afterConfirmedCommit?.();
      return result;
    },
  };
  const projects = {
    store,
    authorization: {
      async authorize(
        request: Parameters<
          NonNullable<
            typeof base.dependencies.creativeProjects
          >["authorization"]["authorize"]
        >[0],
      ) {
        state.projectPermissions.push(request.action);
        return state.deniedProject
          ? { outcome: "deny" as const, reasonCode: "withdrawn" }
          : { outcome: "allow" as const };
      },
    },
  };
  function appendInput(prompt = "后来确认的概念") {
    const next = appendConceptAssetRevision(
      {
        project: state.project,
        actor: taskActor,
        expectedProjectRevision: state.project.revision,
        expectedAssetMetadataRevision: state.asset.revision,
        asset: state.asset,
        brief: state.briefs.get(1)!,
        prompt,
        at,
      },
      taskDigester,
    );
    state.project = next.project;
    state.asset = next.asset;
    state.revisions.set(next.assetRevision.assetRevision, next.assetRevision);
    return next;
  }
  function archive() {
    state.project = setCreativeProjectState({
      project: state.project,
      actor: taskActor,
      expectedProjectRevision: state.project.revision,
      state: "archived",
      at,
    });
  }
  return {
    base,
    state,
    store,
    projects,
    extensions,
    authority,
    reference,
    command,
    original: { ...concept, brief: initial.brief },
    appendInput,
    archive,
    create: (patch: Parameters<typeof base.create>[0] = {}) =>
      base.create({ extensions, creativeProjects: projects, ...patch }),
    generate: () =>
      base
        .create({ extensions, creativeProjects: projects })
        .createProjectTaskFromPlugin(
          taskActor,
          command,
          taskPin,
          reference,
          authority,
        ),
  };
}
