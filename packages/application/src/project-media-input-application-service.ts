import { ProjectMediaReferenceImageApplicationService } from "./project-media-reference-image-service.ts";
import { types } from "node:util";
import {
  captureProjectMediaInputRunCommitTransaction,
  assertProjectMediaInputRunCommand,
  type ProjectMediaInputRunCommitTransactionAuthority,
} from "./project-media-input-run-commit-authority.ts";
import { parseProjectMediaInputListQuery } from "./project-media-input-catalog.ts";
import { ProjectAssetReferenceImageApplicationService } from "./project-asset-reference-image-application-service.ts";
import { ProjectMaterialTargetApplicationService } from "./project-material-target-application-service.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  ProjectMediaInputStore,
  ProjectMediaWorkflowReview,
  ProjectMediaInputRevision,
  SaveProjectMediaInputCommand,
} from "./project-media-input-port.ts";
import {
  parseSaveProjectMediaInputCommand,
  parseProjectMediaInputQuery,
  parseProjectMediaWorkflowReview,
  mediaInputRoles,
  mediaInputActor,
  mediaInputData,
  mediaInputDigest,
  assertProjectMediaWorkflowReview,
  projectMediaInputFail as fail,
} from "./project-media-input-record.ts";
import {
  parseProjectMaterialPreparationRequest,
  materialPreparationFields,
} from "./project-material-preparation-record.ts";
import {
  projectMediaInputAuthority,
  captureProjectMediaInputAuthorization,
  projectMediaInputBound as bound,
  type ProjectMediaInputAuthorizationPort,
} from "./project-media-input-application-authority.ts";
import {
  projectAssetId,
  projectAssetTimestamp,
  projectAssetRevision,
} from "@crewon/domain";

/** Saves confirmed versioned logical inputs with real selected references. No media I/O or Run is performed. */
export class ProjectMediaInputApplicationService {
  readonly #store: ProjectMediaInputStore;
  readonly #source: ProjectMediaReferenceImageApplicationService["resolveSelectedReference"];
  readonly #target: ProjectMaterialTargetApplicationService["resolveTarget"];
  readonly #reviews: readonly ProjectMediaWorkflowReview[];
  readonly #authorization: ProjectMediaInputAuthorizationPort;
  readonly #id: () => string;
  readonly #now: () => string;
  constructor(
    input: Readonly<{
      store: ProjectMediaInputStore;
      sources:
        | ProjectAssetReferenceImageApplicationService
        | ProjectMediaReferenceImageApplicationService;
      targets: ProjectMaterialTargetApplicationService;
      reviews: readonly ProjectMediaWorkflowReview[];
      authorization: ProjectMediaInputAuthorizationPort;
      ids: Readonly<{ nextMediaInputId(): string }>;
      clock: Readonly<{ now(): string }>;
    }>,
  ) {
    if (
      !(
        input.sources instanceof ProjectAssetReferenceImageApplicationService ||
        input.sources instanceof ProjectMediaReferenceImageApplicationService
      ) ||
      !(input.targets instanceof ProjectMaterialTargetApplicationService) ||
      types.isProxy(input.sources) ||
      types.isProxy(input.targets)
    )
      fail("dependency_invalid");
    this.#source =
      input.sources instanceof ProjectMediaReferenceImageApplicationService
        ? ProjectMediaReferenceImageApplicationService.prototype.resolveSelectedReference.bind(
            input.sources,
          )
        : ProjectAssetReferenceImageApplicationService.prototype.resolveSelectedReference.bind(
            input.sources,
          );
    this.#target =
      ProjectMaterialTargetApplicationService.prototype.resolveTarget.bind(
        input.targets,
      );
    this.#store = Object.freeze({
      list: bound<ProjectMediaInputStore["list"]>(input.store, "list"),
      load: bound<ProjectMediaInputStore["load"]>(input.store, "load"),
      loadReceipt: bound<ProjectMediaInputStore["loadReceipt"]>(
        input.store,
        "loadReceipt",
      ),
      save: bound<ProjectMediaInputStore["save"]>(input.store, "save"),
      qualify: bound<ProjectMediaInputStore["qualify"]>(input.store, "qualify"),
    });
    this.#reviews = captureProjectMediaWorkflowReviews(input.reviews);
    this.#authorization = captureProjectMediaInputAuthorization(
      input.authorization,
    );
    this.#id = bound(input.ids, "nextMediaInputId");
    this.#now = bound(input.clock, "now");
  }
  async saveInput(
    actorInput: ActorContext,
    input: SaveProjectMediaInputCommand,
    options?: Readonly<{
      runTransaction: ProjectMediaInputRunCommitTransactionAuthority;
    }>,
  ) {
    const actor = mediaInputActor(actorInput),
      command = parseSaveProjectMediaInputCommand(input);
    const runTransaction =
      options === undefined
        ? undefined
        : captureProjectMediaInputRunCommitTransaction(
            materialPreparationFields(options, ["runTransaction"])
              .runTransaction,
          );
    assertProjectMediaInputRunCommand(runTransaction, actor, command);
    const roles = mediaInputRoles(command.workflowId),
      read = projectMediaInputAuthority({
        actor,
        projectId: command.projectId,
        action: "read",
        review: null,
        mediaInputId: command.mediaInputId,
        inputRevision: null,
        command,
        authorization: this.#authorization,
        ...(runTransaction === undefined ? {} : { runTransaction }),
      });
    const intent = projectMediaInputAuthority({
      actor,
      projectId: command.projectId,
      action: "write",
      review: null,
      mediaInputId: command.mediaInputId,
      inputRevision: null,
      command,
      authorization: this.#authorization,
      ...(runTransaction === undefined ? {} : { runTransaction }),
    });
    await intent.assertCurrent();
    const existing = await this.#store.loadReceipt({ actor, command }, read);
    if (existing) {
      await intent.assertCurrent();
      return Object.freeze({
        disposition: "replayed" as const,
        input: existing,
      });
    }
    const target = await this.#target(
        parseProjectMaterialPreparationRequest({
          source: {
            actor,
            query: command.references[roles[0]!]!,
            idempotencyKey: "media-target-review",
          },
          target: command.target,
          idempotencyKey: command.idempotencyKey,
        }),
      ),
      review = resolveProjectMediaWorkflowReview(this.#reviews, {
        target,
        workflowId: command.workflowId,
      }),
      authority = projectMediaInputAuthority({
        actor,
        projectId: command.projectId,
        action: "write",
        review,
        mediaInputId: command.mediaInputId,
        inputRevision: null,
        command,
        authorization: this.#authorization,
        ...(runTransaction === undefined ? {} : { runTransaction }),
      });
    await authority.assertCurrent();
    const sources = [];
    for (const role of roles)
      sources.push(
        Object.freeze({
          role,
          source: await this.#source(actor, command.references[role]!),
        }),
      );
    return this.#store.save(
      {
        actor,
        command,
        createdMediaInputId:
          command.mediaInputId === null ? projectAssetId(this.#id()) : null,
        sources,
        target,
        workflow: review.workflow,
        at: projectAssetTimestamp(this.#now()),
      },
      authority,
    );
  }
  listInputs(
    actor: ActorContext,
    input: Omit<Parameters<ProjectMediaInputStore["list"]>[0], "actor">,
  ) {
    const query = parseProjectMediaInputListQuery({
      actor,
      ...materialPreparationFields(input, [
        "projectId",
        "afterMediaInputId",
        "limit",
      ]),
    });
    const authority = projectMediaInputAuthority({
      actor: query.actor,
      projectId: query.projectId,
      mediaInputId: null,
      inputRevision: null,
      action: "read",
      review: null,
      command: null,
      authorization: this.#authorization,
    });
    return this.#store.list(query, authority);
  }
  loadInput(
    actorInput: ActorContext,
    input: Readonly<{
      projectId: string;
      mediaInputId: string;
      inputRevision: number | null;
    }>,
  ) {
    const query = parseProjectMediaInputQuery({
        actor: actorInput,
        ...materialPreparationFields(input, [
          "projectId",
          "mediaInputId",
          "inputRevision",
        ]),
      }),
      authority = projectMediaInputAuthority({
        ...query,
        action: "read",
        review: null,
        command: null,
        authorization: this.#authorization,
      });
    return this.#store.load(query, authority);
  }
  async qualifyInput(
    actorInput: ActorContext,
    input: Readonly<{
      projectId: string;
      mediaInputId: string;
      inputRevision: number;
      expectedInputRevision: number;
    }>,
  ) {
    const f = materialPreparationFields(input, [
        "projectId",
        "mediaInputId",
        "inputRevision",
        "expectedInputRevision",
      ]),
      query = parseProjectMediaInputQuery({
        actor: actorInput,
        projectId: f.projectId,
        mediaInputId: f.mediaInputId,
        inputRevision: projectAssetRevision(f.inputRevision),
      }),
      expectedInputRevision = projectAssetRevision(f.expectedInputRevision),
      read = projectMediaInputAuthority({
        ...query,
        action: "read",
        review: null,
        command: null,
        authorization: this.#authorization,
      }),
      state = await this.#store.load(query, read);
    if (!state) fail("not_found");
    const review = resolveProjectMediaWorkflowReview(this.#reviews, {
      target: state.input.target,
      workflowId: state.input.workflow.workflowId,
    });
    const authority = projectMediaInputAuthority({
      ...query,
      action: "qualify",
      review,
      command: null,
      authorization: this.#authorization,
    });
    return this.#store.qualify({ ...query, expectedInputRevision }, authority);
  }
}
export function captureProjectMediaWorkflowReviews(
  input: readonly ProjectMediaWorkflowReview[],
): readonly ProjectMediaWorkflowReview[] {
  const copy = mediaInputData(input);
  // Native approvals retain both workflows for up to 32 immutable packages.
  // Keep the complete historical pins under the same bounded review budget.
  if (!Array.isArray(copy) || copy.length < 1 || copy.length > 32 * 2)
    fail("review_invalid");
  const reviews = copy.map(parseProjectMediaWorkflowReview);
  if (
    new Set(
      reviews.map((r) =>
        mediaInputDigest({
          target: r.targetIdentity,
          workflowId: r.workflow.workflowId,
        }),
      ),
    ).size !== reviews.length
  )
    fail("review_invalid");
  return Object.freeze(reviews);
}
export function resolveProjectMediaWorkflowReview(
  reviews: readonly ProjectMediaWorkflowReview[],
  input: Readonly<{
    target: ProjectMediaInputRevision["target"];
    workflowId: ProjectMediaInputRevision["workflow"]["workflowId"];
  }>,
) {
  const review = reviews.find((r) => {
    if (r.workflow.workflowId !== input.workflowId) return false;
    try {
      assertProjectMediaWorkflowReview(r, {
        target: input.target,
        workflow: r.workflow,
      });
      return true;
    } catch {
      return false;
    }
  });
  if (!review) fail("workflow_unreviewed");
  return review;
}
