import { types } from "node:util";
import {
  captureProjectMediaInputAuthorization,
  captureProjectMediaWorkflowReviews,
  projectMediaInputAuthority,
  parseProjectMediaInputQuery,
  mediaInputSame,
  materialPreparationFields,
  projectMediaInputFail as fail,
  resolveProjectMediaWorkflowReview,
  type ProjectMediaInputAuthorizationPort,
  type ProjectMediaWorkflowReview,
  type ActorContext,
  type ProjectMediaInputStore,
  type ProjectMediaInputRevision,
  type ProjectMediaRole,
} from "@crewon/application";
import {
  SqliteProjectMediaInputStore,
  PostgresProjectMediaInputStore,
} from "@crewon/store";
import { projectAssetRevision } from "@crewon/domain";
import {
  ProjectMaterialPreparer,
  type ProjectMaterialPreparationResult,
} from "./project-material-preparer.ts";
export type ProjectMediaPreparationQuery = Readonly<{
  projectId: string;
  mediaInputId: string;
  inputRevision: number;
  expectedInputRevision: number;
}>;
export type ProjectMediaPreparedMaterials = Readonly<{
  disposition: "verified" | "pending" | "rejected";
  input: ProjectMediaInputRevision;
  materials: readonly Readonly<{
    role: ProjectMediaRole;
    preparation: ProjectMaterialPreparationResult;
  }>[];
}>;
/** Saved input -> per-role actual material preparation. Metadata/byte observations do not admit a Run. */
export class ProjectMediaMaterialPreparer {
  readonly #store: ProjectMediaInputStore;
  readonly #reviews: readonly ProjectMediaWorkflowReview[];
  readonly #authorization: ProjectMediaInputAuthorizationPort;
  readonly #prepare: ProjectMaterialPreparer["prepareSelectedReference"];
  readonly #observe: ProjectMaterialPreparer["observePreparedReference"];
  constructor(
    input: Readonly<{
      store: ProjectMediaInputStore;
      preparer: ProjectMaterialPreparer;
      reviews: readonly ProjectMediaWorkflowReview[];
      authorization: ProjectMediaInputAuthorizationPort;
    }>,
  ) {
    if (types.isProxy(input.store) || types.isProxy(input.preparer))
      fail("dependency_invalid");
    const p =
      input.store instanceof SqliteProjectMediaInputStore
        ? SqliteProjectMediaInputStore.prototype
        : input.store instanceof PostgresProjectMediaInputStore
          ? PostgresProjectMediaInputStore.prototype
          : null;
    if (!p || !(input.preparer instanceof ProjectMaterialPreparer))
      fail("dependency_invalid");
    this.#store = Object.freeze({
      load: p.load.bind(input.store),
      loadReceipt: p.loadReceipt.bind(input.store),
      save: p.save.bind(input.store),
      qualify: p.qualify.bind(input.store),
    });
    this.#prepare =
      ProjectMaterialPreparer.prototype.prepareSelectedReference.bind(
        input.preparer,
      );
    this.#observe =
      ProjectMaterialPreparer.prototype.observePreparedReference.bind(
        input.preparer,
      );
    this.#reviews = captureProjectMediaWorkflowReviews(input.reviews);
    this.#authorization = captureProjectMediaInputAuthorization(
      input.authorization,
    );
  }
  prepareInput(
    actor: ActorContext,
    input: ProjectMediaPreparationQuery,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    return this.#execute(actor, input, "prepare", options.signal);
  }
  observeInput(
    actor: ActorContext,
    input: ProjectMediaPreparationQuery,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    return this.#execute(actor, input, "observe", options.signal);
  }
  async #execute(
    actor: ActorContext,
    input: ProjectMediaPreparationQuery,
    mode: "prepare" | "observe",
    parentSignal: AbortSignal,
  ): Promise<ProjectMediaPreparedMaterials> {
    const f = materialPreparationFields(input, [
        "projectId",
        "mediaInputId",
        "inputRevision",
        "expectedInputRevision",
      ]),
      query = parseProjectMediaInputQuery({
        actor,
        projectId: f.projectId,
        mediaInputId: f.mediaInputId,
        inputRevision: projectAssetRevision(f.inputRevision),
      }),
      expectedInputRevision = projectAssetRevision(f.expectedInputRevision),
      signal = AbortSignal.any([parentSignal, AbortSignal.timeout(90_000)]),
      read = projectMediaInputAuthority({
        ...query,
        action: "read",
        review: null,
        command: null,
        authorization: this.#authorization,
        signal,
      }),
      state = await this.#store.load(query, read);
    if (!state) fail("not_found");
    const review = resolveProjectMediaWorkflowReview(this.#reviews, {
        target: state.input.target,
        workflowId: state.input.workflow.workflowId,
      }),
      authority = projectMediaInputAuthority({
        ...query,
        action: "qualify",
        review,
        command: null,
        authorization: this.#authorization,
        signal,
      }),
      qualify = () =>
        this.#store.qualify({ ...query, expectedInputRevision }, authority);
    const current = await qualify(),
      materials = [];
    for (const r of current.references) {
      await qualify();
      const request = r.preparation;
      const preparation = await (
        mode === "prepare" ? this.#prepare : this.#observe
      )(
        query.actor,
        {
          source: {
            query: request.source.query,
            idempotencyKey: request.source.idempotencyKey,
          },
          target: request.target,
          idempotencyKey: request.idempotencyKey,
        },
        { signal },
      );
      if (
        !mediaInputSame(preparation.state.initial.request, request) ||
        !mediaInputSame(preparation.state.initial.target, current.target)
      )
        fail("preparation_changed");
      await qualify();
      materials.push(Object.freeze({ role: r.role, preparation }));
    }
    const final = await qualify();
    if (final.contentDigest !== current.contentDigest) fail("source_changed");
    if (
      current.workflow.workflowId === "flux2-three-reference-storyboard" &&
      materials[1]!.preparation.state.initial.source.source.byteDigest ===
        materials[2]!.preparation.state.initial.source.source.byteDigest
    )
      fail("characters_duplicated");
    const disposition = materials.some(
      (m) => m.preparation.disposition === "rejected",
    )
      ? "rejected"
      : materials.every((m) => m.preparation.disposition === "verified")
        ? "verified"
        : "pending";
    return Object.freeze({
      disposition,
      input: current,
      materials: Object.freeze(materials),
    });
  }
}
