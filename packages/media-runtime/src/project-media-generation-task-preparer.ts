import { types } from "node:util";
import {
  mediaInputActor,
  mediaInputData,
  mediaInputSame,
  mediaInputDigest,
  materialPreparationFields,
  parseProjectMediaInputQuery,
  parseProjectMediaGenerationReference,
  parseProjectMediaGenerationLink,
  projectMediaGenerationTaskInput,
  projectMediaInputAuthority,
  projectMediaInputBound,
  captureProjectMediaWorkflowReviews,
  captureProjectMediaInputAuthorization,
  captureProjectGenerationImageResultVerifier,
  resolveProjectMediaWorkflowReview,
  captureProjectMediaGenerationAuthority,
  assertProjectMediaGenerationCurrent,
  mediaGenerationFail as fail,
  type ActorContext,
  type ProjectMediaInputStore,
  type ExtensionRunLocator,
  type ProjectMediaInputAuthorizationPort,
  type ProjectMediaWorkflowReview,
  type ProjectGenerationImageResultVerifier,
  type ProjectMediaGenerationAuthorizationPort,
  type ProjectMediaGenerationPermission,
  type ProjectMediaGenerationTask,
  type ProjectMediaGenerationReference,
  type ProjectMediaInputRevision,
} from "@crewon/application";
import {
  projectAssetId,
  projectAssetRevision,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import {
  SqliteProjectMediaInputStore,
  PostgresProjectMediaInputStore,
  SqliteExtensionStore,
  PostgresExtensionStore,
} from "@crewon/store";
import {
  ProjectMediaMaterialPreparer,
  type ProjectMediaPreparationQuery,
  type ProjectMediaPreparedMaterials,
} from "./project-media-material-preparer.ts";

/** Host-owned qualification for both entry points. Never uploads or generates during replay. */
export class ProjectMediaGenerationTaskPreparer {
  readonly #prepare: ProjectMediaMaterialPreparer["prepareInput"];
  readonly #observe: ProjectMediaMaterialPreparer["observeInput"];
  readonly #load: ProjectMediaInputStore["load"];
  readonly #links: SqliteExtensionStore["loadProjectMediaGenerationLink"];
  readonly #reviews: readonly ProjectMediaWorkflowReview[];
  readonly #metadata: ProjectMediaInputAuthorizationPort;
  readonly #purpose: ProjectMediaGenerationAuthorizationPort;
  readonly #verifier: ProjectGenerationImageResultVerifier;
  constructor(
    input: Readonly<{
      materials: ProjectMediaMaterialPreparer;
      store: ProjectMediaInputStore;
      extensions: SqliteExtensionStore | PostgresExtensionStore;
      reviews: readonly ProjectMediaWorkflowReview[];
      metadataAuthorization: ProjectMediaInputAuthorizationPort;
      authorization: ProjectMediaGenerationAuthorizationPort;
      verifier: ProjectGenerationImageResultVerifier;
    }>,
  ) {
    const proto =
      input.store instanceof SqliteProjectMediaInputStore
        ? SqliteProjectMediaInputStore.prototype
        : input.store instanceof PostgresProjectMediaInputStore
          ? PostgresProjectMediaInputStore.prototype
          : null;
    const ext =
      input.extensions instanceof SqliteExtensionStore
        ? SqliteExtensionStore.prototype
        : input.extensions instanceof PostgresExtensionStore
          ? PostgresExtensionStore.prototype
          : null;
    if (
      !proto ||
      !ext ||
      !(input.materials instanceof ProjectMediaMaterialPreparer) ||
      [input.store, input.extensions, input.materials].some((v) =>
        types.isProxy(v),
      )
    )
      fail("dependency_invalid");
    this.#prepare = ProjectMediaMaterialPreparer.prototype.prepareInput.bind(
      input.materials,
    );
    this.#observe = ProjectMediaMaterialPreparer.prototype.observeInput.bind(
      input.materials,
    );
    this.#load = proto.load.bind(input.store);
    this.#links = ext.loadProjectMediaGenerationLink.bind(input.extensions);
    this.#reviews = captureProjectMediaWorkflowReviews(input.reviews);
    this.#metadata = captureProjectMediaInputAuthorization(
      input.metadataAuthorization,
    );
    this.#purpose = Object.freeze({
      authorize: projectMediaInputBound<
        ProjectMediaGenerationAuthorizationPort["authorize"]
      >(input.authorization, "authorize"),
      assertActive: projectMediaInputBound<
        ProjectMediaGenerationAuthorizationPort["assertActive"]
      >(input.authorization, "assertActive"),
    });
    this.#verifier = captureProjectGenerationImageResultVerifier(
      input.verifier,
    );
  }
  /** A new user execution prepares materials only after its independent generation purpose is allowed. */
  async prepareTask(
    actorInput: ActorContext,
    input: ProjectMediaPreparationQuery & Readonly<{ executionId: string }>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<ProjectMediaGenerationTask> {
    const actor = mediaInputActor(actorInput),
      fields = materialPreparationFields(input, [
        "projectId",
        "mediaInputId",
        "inputRevision",
        "expectedInputRevision",
        "executionId",
      ]),
      query = {
        projectId: projectAssetId(fields.projectId),
        mediaInputId: projectAssetId(fields.mediaInputId),
        inputRevision: projectAssetRevision(fields.inputRevision),
        expectedInputRevision: projectAssetRevision(
          fields.expectedInputRevision,
        ),
      },
      executionId = projectAssetId(fields.executionId),
      permission = this.#permission(actor, { ...query, executionId });
    await this.#purposeCurrent(permission, options.signal);
    const prepared = await this.#prepare(actor, query, options);
    await this.#purposeCurrent(permission, options.signal);
    if (prepared.disposition !== "verified") fail("materials_unavailable");
    return this.qualifyTask(actor, { ...query, executionId }, options);
  }

  async qualifyTask(
    actorInput: ActorContext,
    input: ProjectMediaPreparationQuery & Readonly<{ executionId: string }>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<ProjectMediaGenerationTask> {
    const actor = mediaInputActor(actorInput),
      r = materialPreparationFields(input, [
        "projectId",
        "mediaInputId",
        "inputRevision",
        "expectedInputRevision",
        "executionId",
      ]),
      query = {
        ...parseProjectMediaInputQuery({
          actor,
          projectId: r.projectId,
          mediaInputId: r.mediaInputId,
          inputRevision: projectAssetRevision(r.inputRevision),
        }),
        inputRevision: projectAssetRevision(r.inputRevision),
        expectedInputRevision: projectAssetRevision(r.expectedInputRevision),
      },
      executionId = projectAssetId(r.executionId),
      permission = this.#permission(actor, {
        projectId: query.projectId,
        mediaInputId: query.mediaInputId,
        inputRevision: query.inputRevision,
        expectedInputRevision: query.expectedInputRevision,
        executionId,
      });
    await this.#purposeCurrent(permission, options.signal);
    const { actor: _, ...selectors } = query;
    const observed = await this.#observe(actor, selectors, options);
    const reference = this.#reference(
      observed,
      query.expectedInputRevision,
      executionId,
    );
    await this.#purposeCurrent(permission, options.signal);
    return this.#task(
      actor,
      reference,
      observed.input,
      permission,
      options.signal,
    );
  }
  async restoreAcceptedTask(
    actorInput: ActorContext,
    input: ExtensionRunLocator,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<ProjectMediaGenerationTask> {
    const actor = mediaInputActor(actorInput),
      fields = materialPreparationFields(input, [
        "tenantId",
        "spaceId",
        "runId",
      ]),
      locator = {
        tenantId: projectAssetId(fields.tenantId),
        spaceId: projectAssetId(fields.spaceId),
        runId: projectAssetId(fields.runId),
      };
    if (
      actor.tenantId !== locator.tenantId ||
      actor.spaceId !== locator.spaceId
    )
      fail("owner_mismatch");
    options.signal.throwIfAborted();
    const raw = await this.#links(locator);
    if (!raw) fail("link_missing");
    const link = parseProjectMediaGenerationLink(raw);
    if (!mediaInputSame(link.actor, actor)) fail("owner_mismatch");
    const r = link.reference,
      permission = this.#permission(actor, {
        projectId: r.projectId,
        mediaInputId: r.mediaInputId,
        inputRevision: r.inputRevision,
        expectedInputRevision: r.expectedInputRevision,
        executionId: r.executionId,
      });
    await this.#purposeCurrent(permission, options.signal);
    const read = projectMediaInputAuthority({
      actor,
      projectId: r.projectId,
      mediaInputId: r.mediaInputId,
      inputRevision: r.inputRevision,
      action: "read",
      review: null,
      command: null,
      authorization: this.#metadata,
      signal: options.signal,
    });
    const saved = await this.#load(
      {
        actor,
        projectId: r.projectId,
        mediaInputId: r.mediaInputId,
        inputRevision: r.inputRevision,
      },
      read,
    );
    if (!saved || saved.input.contentDigest !== r.mediaInputDigest)
      fail("history_invalid");
    await this.#purposeCurrent(permission, options.signal);
    return this.#task(actor, r, saved.input, permission, options.signal);
  }
  #permission(
    actor: ActorContext,
    resource: ProjectMediaGenerationPermission["resource"],
  ): ProjectMediaGenerationPermission {
    return mediaInputData({
      actor,
      action: "projectMedia:generate",
      resource,
    }) as ProjectMediaGenerationPermission;
  }
  async #purposeCurrent(
    permission: ProjectMediaGenerationPermission,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.#purposeActive(permission, signal);
    const decision = await this.#purpose.authorize(permission);
    this.#purposeActive(permission, signal);
    if (decision.outcome !== "allow") fail("denied");
  }
  #purposeActive(
    permission: ProjectMediaGenerationPermission,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const result: unknown = this.#purpose.assertActive(permission);
    if (result !== undefined) {
      try {
        void Promise.prototype.then.call(
          result,
          () => undefined,
          () => undefined,
        );
      } catch {
        /* Never invoke arbitrary thenables. */
      }
      fail("authority_invalid");
    }
  }
  #reference(
    observed: ProjectMediaPreparedMaterials,
    expectedInputRevision: number,
    executionId: string,
  ): ProjectMediaGenerationReference {
    if (observed.disposition !== "verified") fail("materials_unavailable");
    const r = observed.input;
    return parseProjectMediaGenerationReference({
      schemaVersion: "crewon.project-media-generation-reference.v1",
      projectId: r.projectId,
      mediaInputId: r.mediaInputId,
      inputRevision: r.inputRevision,
      expectedInputRevision,
      executionId,
      mediaInputDigest: r.contentDigest,
      workflowId: r.workflow.workflowId,
      materials: observed.materials.map((m) => ({
        role: m.role,
        intentId: m.preparation.state.initial.intentId,
        initialDigest: m.preparation.state.initial.contentDigest,
        eventRevision: m.preparation.state.event.revision,
        eventDigest: mediaInputDigest(m.preparation.state.event),
      })),
    });
  }
  #task(
    actor: ActorContext,
    reference: ProjectMediaGenerationReference,
    input: ProjectMediaInputRevision,
    permission: ProjectMediaGenerationPermission,
    signal: AbortSignal,
  ): ProjectMediaGenerationTask {
    const review = resolveProjectMediaWorkflowReview(this.#reviews, {
        target: input.target,
        workflowId: input.workflow.workflowId,
      }),
      metadata = projectMediaInputAuthority({
        actor,
        projectId: reference.projectId,
        mediaInputId: reference.mediaInputId,
        inputRevision: reference.inputRevision,
        action: "qualify",
        review,
        command: null,
        authorization: this.#metadata,
        signal,
      }),
      current = () => this.#purposeCurrent(permission, signal),
      authority = captureProjectMediaGenerationAuthority(
        {
          version: "crewon.project-media-generation-commit.v1",
          actor,
          reference,
          metadata,
          verifier: this.#verifier,
          assertCurrent: current,
          assertTransactionCurrent: current,
          assertActive: () => this.#purposeActive(permission, signal),
        },
        actor,
        reference,
      );
    const observe = async () => {
      await assertProjectMediaGenerationCurrent(authority, "before");
      const r = reference,
        observed = await this.#observe(
          actor,
          {
            projectId: r.projectId,
            mediaInputId: r.mediaInputId,
            inputRevision: r.inputRevision,
            expectedInputRevision: r.expectedInputRevision,
          },
          { signal },
        );
      if (
        !mediaInputSame(
          this.#reference(observed, r.expectedInputRevision, r.executionId),
          reference,
        )
      )
        fail("material_changed");
      await assertProjectMediaGenerationCurrent(authority, "before");
    };
    return Object.freeze({
      reference,
      authority,
      preflight: Object.freeze({
        async assertNewInput(value: WorkflowSchemaValue) {
          if (
            !mediaInputSame(value, projectMediaGenerationTaskInput(reference))
          )
            fail("input_mismatch");
          await observe();
        },
        assertDispatchCurrent: observe,
      }),
    });
  }
}
