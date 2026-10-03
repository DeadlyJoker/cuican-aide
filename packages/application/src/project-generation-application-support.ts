import {
  CreativeProjectError,
  assertProjectGenerationReplay,
  extensionCanonicalJson,
  parseProjectGenerationReference,
  validateProjectGenerationSource,
  type ProjectGenerationReference,
  type ExtensionRunBinding,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectStore,
} from "./creative-project-store-port.ts";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  captureCreativeProjectCommitAuthority,
  captureCreativeProjectTransactionAuthority,
} from "./creative-project-commit-authority.ts";
import {
  checkedCreativeAsset,
  checkedCreativeAssetRevision,
  checkedCreativeBrief,
  checkedCreativeProject,
  creativeInput,
  creativeOwner,
  creativeProjectUseCase,
  creativeStored,
} from "./creative-project-application-support.ts";
import type {
  CommitExtensionTurnOptions,
  ExtensionMutationReceipt,
  ExtensionStore,
} from "./extension-store-port.ts";
import {
  authorizeExtension,
  extensionScopeFor,
} from "./extension-application-support.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import { projectGenerationTaskReceipt } from "./project-generation-task-receipt.ts";
import {
  captureProjectGenerationExecutionPublication,
  projectGenerationHostFields,
  type CreatePublishedProjectTaskInput,
  type ProjectGenerationExecutionPublication,
} from "./project-generation-execution-authority.ts";

/** Trusted host composition must supply the existing project store and its current access policy. */
export type ProjectGenerationApplicationPorts = Readonly<{
  store: CreativeProjectStore;
  authorization: CreativeProjectAuthorizationPort;
}>;

export type CapturedProjectGenerationTask = Readonly<{
  reference: ProjectGenerationReference;
  authority: CreativeProjectCommitAuthority;
  preflight?: CreativeProjectCommitAuthority;
  publication?: ProjectGenerationExecutionPublication;
}>;

/** Explicit two-owner entry, separate from the compatible original internal generation recipe. */
export function capturePublishedProjectGenerationTask(
  input: CreatePublishedProjectTaskInput,
) {
  const value = projectGenerationHostFields(input, [
    "actor",
    "command",
    "reference",
    "publication",
    "sourcePin",
    "executionPin",
    "authority",
  ]);
  const publication = captureProjectGenerationExecutionPublication({
    publication:
      value.publication as CreatePublishedProjectTaskInput["publication"],
    sourcePin: value.sourcePin as CreatePublishedProjectTaskInput["sourcePin"],
    executionPin:
      value.executionPin as CreatePublishedProjectTaskInput["executionPin"],
  });
  const authority = captureCreativeProjectTransactionAuthority(
    value.authority as CreatePublishedProjectTaskInput["authority"],
  );
  return Object.freeze({
    actor: value.actor as ActorContext,
    command: value.command as CreateExtensionTaskCommand,
    executionPin: publication.executionPin,
    captured: Object.freeze({
      reference: creativeInput(() =>
        parseProjectGenerationReference(value.reference),
      ),
      authority: authority.transaction,
      preflight: authority.preflight,
      publication,
    }) satisfies CapturedProjectGenerationTask,
  });
}

/** Called before any await; captures private host callbacks separately from bounded JSON. */
export function captureProjectGenerationTask(
  reference: ProjectGenerationReference,
  authority: CreativeProjectCommitAuthority,
): CapturedProjectGenerationTask {
  const captured = captureCreativeProjectCommitAuthority({ authority });
  if (captured === undefined)
    throw new ApplicationError(
      "conflict",
      "creative_project_generation_authority_unavailable",
    );
  return Object.freeze({
    reference: creativeInput(() => parseProjectGenerationReference(reference)),
    authority: captured,
  });
}

export function projectGenerationTaskAdmission(
  input: Readonly<{
    captured: CapturedProjectGenerationTask;
    projects: ProjectGenerationApplicationPorts | undefined;
    extensions: ExtensionStore;
    executionAuthorization: AuthorizationPort;
    digester: ContentDigester;
    actor: ActorContext;
    command: CreateExtensionTaskCommand;
  }>,
) {
  const { captured, extensions, digester, actor, command } = input;
  const projects = input.projects;
  if (
    projects === undefined ||
    extensions.projectGenerationVersion !==
      "crewon.project-generation-link.v0" ||
    typeof extensions.loadProjectGenerationLink !== "function"
  )
    throw new ApplicationError(
      "conflict",
      "creative_project_generation_unavailable",
    );
  if (command.intent.kind !== "generate")
    throw new ApplicationError(
      "validation",
      "creative_project_generation_intent_invalid",
    );
  if (
    captured.publication !== undefined &&
    extensions.projectGenerationPublicationVersion !==
      "crewon.project-generation-publication.v1"
  )
    throw new ApplicationError(
      "conflict",
      "creative_project_generation_publication_unavailable",
    );
  const owner = creativeOwner(actor);
  const reference = captured.reference;
  const loadLink = extensions.loadProjectGenerationLink.bind(extensions);
  const loadProject = projects.store.loadProject.bind(projects.store);
  const loadAsset = projects.store.loadConceptAsset.bind(projects.store);
  const loadRevision = projects.store.loadConceptRevision.bind(projects.store);
  const loadBrief = projects.store.loadBrief.bind(projects.store);
  const authorize = projects.authorization.authorize.bind(
    projects.authorization,
  );

  async function currentProject() {
    const raw = await loadProject({ owner, projectId: reference.projectId });
    if (raw === null)
      throw new ApplicationError("notFound", "creative_project_not_found");
    return checkedCreativeProject(raw, owner, reference.projectId);
  }
  // Transaction callbacks must not acquire another connection from the shared pool.
  // Owner/source reads happen before admission and again on the Store's locked client.
  async function authorizePolicy() {
    const decision = await authorize({
      actor,
      action: "creativeProject:write",
      resource: {
        kind: "creativeProject",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        projectId: reference.projectId,
      },
    });
    if (decision.outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
    await authorizeExtension(
      input.executionAuthorization,
      actor,
      "extension:run",
      extensionScopeFor(actor, command.pluginId),
    );
    for (const request of [
      {
        actor,
        action: "thread:message:append" as const,
        resource: {
          kind: "thread" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: command.threadId,
        },
      },
      {
        actor,
        action: "run:create" as const,
        resource: {
          kind: "run" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: command.threadId,
          runId: null,
        },
      },
    ])
      if (
        (await input.executionAuthorization.authorize(request)).outcome !==
        "allow"
      )
        throw new ApplicationError("authorization", "authorization_denied");
    await assertCreativeProjectCommitCurrent(captured.authority);
    assertCreativeProjectCommitActive(captured.authority);
  }
  const authority: CreativeProjectCommitAuthority = Object.freeze({
    assertCurrent: authorizePolicy,
    assertActive: () => assertCreativeProjectCommitActive(captured.authority),
  });
  const commitOptions: CommitExtensionTurnOptions = Object.freeze({
    projectGenerationAuthority: authority,
    ...(captured.publication === undefined
      ? {}
      : { projectGenerationPublication: captured.publication }),
  });
  return Object.freeze({
    reference,
    commitOptions,
    async assertCurrent() {
      await assertCreativeProjectCommitCurrent(captured.preflight);
      assertCreativeProjectCommitActive(captured.preflight);
      await currentProject();
      await authorizePolicy();
    },
    async assertDispatchCurrent() {
      await assertCreativeProjectCommitCurrent(captured.preflight);
      assertCreativeProjectCommitActive(captured.preflight);
    },
    assertActive: () => assertCreativeProjectCommitActive(captured.authority),
    receipt(base: ExtensionMutationReceipt): ExtensionMutationReceipt {
      return projectGenerationTaskReceipt(base, reference, digester);
    },
    async assertNewInput(taskInput: WorkflowSchemaValue): Promise<void> {
      await creativeProjectUseCase(async () => {
        await authorizePolicy();
        const project = await currentProject();
        const rawAsset = await loadAsset({
          owner,
          projectId: reference.projectId,
          assetId: reference.assetId,
        });
        if (rawAsset === null)
          throw new ApplicationError(
            "notFound",
            "creative_project_asset_not_found",
          );
        const asset = checkedCreativeAsset(
          rawAsset,
          project,
          reference.assetId,
        );
        const rawRevision = await loadRevision({
          owner,
          projectId: reference.projectId,
          assetId: reference.assetId,
          assetRevision: reference.assetRevision,
        });
        if (rawRevision === null)
          throw new ApplicationError(
            "notFound",
            "creative_project_asset_revision_not_found",
          );
        const assetRevision = checkedCreativeAssetRevision(
          rawRevision,
          project,
          digester,
          reference.assetId,
          {
            assetRevision: reference.assetRevision,
            latestAssetRevision: asset.latestAssetRevision,
          },
        );
        const rawBrief = await loadBrief({
          owner,
          projectId: reference.projectId,
          briefRevision: assetRevision.briefRevision,
        });
        if (rawBrief === null)
          throw new ApplicationError(
            "notFound",
            "creative_project_brief_not_found",
          );
        const brief = checkedCreativeBrief(
          rawBrief,
          project,
          digester,
          assetRevision.briefRevision,
        );
        validateProjectGenerationSource(
          { actor, reference, project, asset, assetRevision, brief },
          digester,
        );
        if (
          extensionCanonicalJson(taskInput) !==
          extensionCanonicalJson({ prompt: assetRevision.prompt })
        )
          throw new ApplicationError(
            "validation",
            "creative_project_generation_input_mismatch",
          );
      });
    },
    async assertSaved(
      binding: ExtensionRunBinding,
      receipt: ExtensionMutationReceipt,
    ): Promise<void> {
      const raw = await loadLink({
        tenantId: binding.tenantId,
        spaceId: binding.spaceId,
        runId: binding.runId,
      });
      if (raw === null)
        throw new ApplicationError(
          "internal",
          "creative_project_generation_link_missing",
        );
      creativeStored(() =>
        assertProjectGenerationReplay(
          { link: raw, reference, actor, binding, receipt },
          digester,
        ),
      );
    },
  });
}

/** Scoped mapping keeps original task errors unchanged and exposes retryable project CAS conflicts. */
export async function commitProjectGenerationTask<T>(
  commit: () => Promise<T>,
): Promise<T> {
  try {
    return await commit();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    if (error instanceof CreativeProjectError)
      return creativeProjectUseCase(async () => {
        throw error;
      });
    const code = error instanceof Error ? error.message : "";
    if (
      [
        "project_generation_slot_occupied",
        "project_generation_receipt_conflict",
        "project_generation_unavailable",
      ].includes(code)
    )
      throw new ApplicationError("conflict", code, { cause: error });
    if (code === "project_generation_source_not_found")
      throw new ApplicationError("notFound", code, { cause: error });
    // Other errors continue through the original Extension task mapper.
    throw error;
  }
}
