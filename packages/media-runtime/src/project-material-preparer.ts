import { randomUUID } from "node:crypto";
import { types } from "node:util";
import {
  ApplicationError,
  ProjectMaterialTargetApplicationService,
  parseProjectMaterialPreparationRequest,
  materialPreparationFields,
  materialPreparationOrigin,
  materialPreparationUploadAdapter,
  assertProjectMaterialPreparationActive,
  type ActorContext,
  type ProjectMaterialPreparationRequest,
  type ProjectMaterialPreparationState,
  type ProjectMaterialPreparationStore,
  type ProjectMaterialPreparationCommitAuthority,
  type ProjectMaterialPreparationAuthorizationPort,
  type FrozenProjectReferenceMaterialContent,
  type ProjectAssetReferenceImageQuery,
} from "@crewon/application";
import { extensionCanonicalJson, projectAssetTimestamp } from "@crewon/domain";
import { ProjectReferenceMaterialFreezer } from "./project-reference-material-freezer.ts";
import {
  NetworkEgressResolver,
  ProductionNetworkEgressPolicy,
  type NetworkDnsResolver,
} from "./network-egress.ts";
import {
  PinnedNodeHttpTransport,
  type PinnedHttpPort,
} from "./pinned-node-http.ts";
import { MAX_PROJECT_MATERIAL_BYTES } from "./project-material-png.ts";
import {
  renderComfyMaterialUpload,
  verifyComfyMaterialTargetBytes,
  verifyComfyMaterialUploadAcknowledgement,
  type ComfyMaterialUploadPlan,
} from "./comfyui-material-upload.ts";
import {
  captureReviewedMaterialTargets,
  captureMaterialPreparationJournal,
  materialPreparationBound as bound,
  materialPreparationFail as fail,
  type ProjectMaterialTargetIdentity,
} from "./project-material-preparation-support.ts";

export type PrepareProjectMaterialInput = Readonly<{
  source: Readonly<{
    query: ProjectAssetReferenceImageQuery;
    idempotencyKey: string;
  }>;
  target: ProjectMaterialPreparationRequest["target"];
  idempotencyKey: string;
}>;
/** Host-only preparation receipt. An observation never admits a generation Run or grants future network I/O. */
export type ProjectMaterialPreparationResult = Readonly<{
  disposition: "verified" | "pending" | "rejected";
  state: ProjectMaterialPreparationState;
  observation: ProjectMaterialPreparationState["event"]["observation"];
}>;

/** Real source archive + actual target reads + durable single dispatch + independently approved pinned HTTP.
 * Only business selectors enter this service. Original recorded preparations never recapture or reupload.
 */
export class ProjectMaterialPreparer {
  readonly #freeze: ProjectReferenceMaterialFreezer["freezeSelectedReference"];
  readonly #read: ProjectReferenceMaterialFreezer["readFrozenReference"];
  readonly #target: ProjectMaterialTargetApplicationService["resolveTarget"];
  readonly #journal: ProjectMaterialPreparationStore;
  readonly #review: ReturnType<typeof captureReviewedMaterialTargets>;
  readonly #authorize: ProjectMaterialPreparationAuthorizationPort["authorize"];
  readonly #active: ProjectMaterialPreparationAuthorizationPort["assertActive"];
  readonly #now: () => string;
  readonly #upload: PinnedHttpPort;
  readonly #observe: PinnedHttpPort;
  readonly #egress: NetworkEgressResolver;
  constructor(
    input: Readonly<{
      freezer: ProjectReferenceMaterialFreezer;
      targets: ProjectMaterialTargetApplicationService;
      journal: ProjectMaterialPreparationStore;
      reviewedTargets: readonly ProjectMaterialTargetIdentity[];
      authorization: ProjectMaterialPreparationAuthorizationPort;
      clock: Readonly<{ now(): string }>;
      dns?: NetworkDnsResolver;
      uploadTransport?: PinnedHttpPort;
      observationTransport?: PinnedHttpPort;
    }>,
  ) {
    if (
      !(input.freezer instanceof ProjectReferenceMaterialFreezer) ||
      types.isProxy(input.freezer) ||
      !(input.targets instanceof ProjectMaterialTargetApplicationService) ||
      types.isProxy(input.targets)
    )
      fail("dependency_invalid");
    this.#freeze =
      ProjectReferenceMaterialFreezer.prototype.freezeSelectedReference.bind(
        input.freezer,
      );
    this.#read =
      ProjectReferenceMaterialFreezer.prototype.readFrozenReference.bind(
        input.freezer,
      );
    this.#target =
      ProjectMaterialTargetApplicationService.prototype.resolveTarget.bind(
        input.targets,
      );
    this.#journal = captureMaterialPreparationJournal(input.journal);
    this.#review = captureReviewedMaterialTargets(input.reviewedTargets);
    this.#authorize = bound(input.authorization, "authorize");
    this.#active = bound(input.authorization, "assertActive");
    this.#now = bound(input.clock, "now");
    this.#upload =
      input.uploadTransport === undefined
        ? new PinnedNodeHttpTransport({ responseProfile: "imageUpload" })
        : Object.freeze({
            request: bound<PinnedHttpPort["request"]>(
              input.uploadTransport,
              "request",
            ),
          });
    this.#observe =
      input.observationTransport === undefined
        ? new PinnedNodeHttpTransport({ responseProfile: "imageMaterial" })
        : Object.freeze({
            request: bound<PinnedHttpPort["request"]>(
              input.observationTransport,
              "request",
            ),
          });
    this.#egress = new NetworkEgressResolver({
      dns: input.dns,
      policy: new ProductionNetworkEgressPolicy(),
    });
  }
  prepareSelectedReference(
    actor: ActorContext,
    input: PrepareProjectMaterialInput,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    return this.#execute(
      this.#request(actor, input),
      "prepare",
      options.signal,
    );
  }
  /** Cold/reconnect observation never creates a record, captures source bytes or claims another POST. */
  observePreparedReference(
    actor: ActorContext,
    input: PrepareProjectMaterialInput,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    return this.#execute(
      this.#request(actor, input),
      "observe",
      options.signal,
    );
  }
  #request(actor: ActorContext, input: PrepareProjectMaterialInput) {
    const i = materialPreparationFields(input, [
        "source",
        "target",
        "idempotencyKey",
      ]),
      source = materialPreparationFields(i.source, ["query", "idempotencyKey"]);
    return parseProjectMaterialPreparationRequest({
      source: { ...source, actor },
      target: i.target,
      idempotencyKey: i.idempotencyKey,
    });
  }
  async #execute(
    request: ProjectMaterialPreparationRequest,
    mode: "prepare" | "observe",
    parentSignal: AbortSignal,
  ): Promise<ProjectMaterialPreparationResult> {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)]),
      authority = this.#authority(request, signal);
    this.#assertActive(authority);
    // Lookup precedes every possible freeze. Losing the whole archive cannot turn a known dispatch into a new source GET.
    let state = await this.#journal.load(request, authority);
    if (!state && mode === "observe") fail("not_found");
    const target = await this.#target(request);
    this.#review(target);
    if (state && !same(target, state.initial.target)) fail("target_changed");
    await this.#grant(request, "projectMaterial:prepare", state, signal);
    if (!state)
      await this.#freeze(request.source.actor, sourceInput(request), {
        signal,
      });
    const content = await this.#read(
      request.source.actor,
      sourceInput(request),
      { signal },
    );
    if (!state) {
      const proposed = renderComfyMaterialUpload({
        preparationId: randomUUID(),
        targetServiceOrigin: materialPreparationOrigin(target.configuration),
        adapter: materialPreparationUploadAdapter(target.configuration),
        content,
      });
      state = (
        await this.#journal.reserve(
          {
            request,
            source: content.record,
            target,
            proposedTransfer: {
              preparationId: proposed.preparationId,
              requestDigest: proposed.requestDigest,
            },
            at: this.#time(),
          },
          authority,
        )
      ).state;
    }
    const plan = this.#plan(state, content);
    await this.#current(state, signal);
    if (state.event.phase === "rejected")
      return this.#result(state, null, authority);
    if (state.event.phase === "reserved") {
      if (mode === "observe") return this.#result(state, null, authority);
      await this.#grant(request, "projectMaterial:upload", state, signal);
      const destination = await this.#endpoint(
        plan,
        plan.request.path,
        state,
        signal,
      );
      await this.#current(state, signal);
      await this.#grant(request, "projectMaterial:upload", state, signal);
      const claim = await this.#journal.claimDispatch(
        { request, expectedRevision: state.event.revision, at: this.#time() },
        authority,
      );
      state = claim.state;
      if (state.event.phase === "rejected")
        return this.#result(state, null, authority);
      if (claim.disposition === "claimed") {
        // Claim is durable before any send. Failures after this point must never return the record to reserved.
        await this.#current(state, signal);
        await this.#grant(request, "projectMaterial:upload", state, signal);
        let failureCode: string | null = null;
        try {
          const response = await this.#upload.request(
            { ...plan.request, target: destination },
            signal,
          );
          verifyComfyMaterialUploadAcknowledgement(plan, response);
        } catch (error) {
          failureCode =
            error instanceof Error &&
            error.message ===
              "comfyui_material_upload_acknowledgement_identity_changed"
              ? "target_identity_changed"
              : "upload_outcome_unknown";
        }
        await this.#current(state, signal);
        if (failureCode) {
          state = await this.#advance(
            state,
            failureCode === "target_identity_changed"
              ? "rejected"
              : "unknownOutcome",
            null,
            failureCode,
            authority,
          );
          return this.#result(state, null, authority);
        }
      }
    }
    return this.#checkTarget(state, plan, authority, signal);
  }
  #plan(
    state: ProjectMaterialPreparationState,
    content: FrozenProjectReferenceMaterialContent,
  ) {
    if (!same(state.initial.source, content.record)) fail("archive_changed");
    if (
      state.initial.transfer.adapter !==
      materialPreparationUploadAdapter(state.initial.target.configuration)
    )
      fail("transfer_protocol_mismatch");
    const plan = renderComfyMaterialUpload({
      preparationId: state.initial.transfer.preparationId,
      targetServiceOrigin: state.initial.transfer.origin,
      adapter: state.initial.transfer.adapter,
      content,
    });
    if (
      plan.requestDigest !== state.initial.transfer.requestDigest ||
      !same(plan.output, state.initial.transfer.output)
    )
      fail("request_changed");
    return plan;
  }
  async #current(state: ProjectMaterialPreparationState, signal: AbortSignal) {
    signal.throwIfAborted();
    const request = state.initial.request,
      content = await this.#read(request.source.actor, sourceInput(request), {
        signal,
      }),
      target = await this.#target(request);
    this.#review(target);
    if (!same(target, state.initial.target)) fail("target_changed");
    this.#plan(state, content);
    await this.#grant(request, "projectMaterial:prepare", state, signal);
  }
  #endpoint(
    plan: ComfyMaterialUploadPlan,
    path: string,
    state: ProjectMaterialPreparationState,
    signal: AbortSignal,
  ) {
    return this.#egress.resolve(
      {
        tenantId: state.initial.request.source.actor.tenantId,
        scopeId: state.initial.contentDigest,
        endpoint: new URL(path, plan.origin),
      },
      signal,
    );
  }
  async #checkTarget(
    state: ProjectMaterialPreparationState,
    plan: ComfyMaterialUploadPlan,
    authority: ProjectMaterialPreparationCommitAuthority,
    signal: AbortSignal,
  ): Promise<ProjectMaterialPreparationResult> {
    const request = state.initial.request;
    await this.#grant(request, "projectMaterial:observe", state, signal);
    let target;
    try {
      target = await this.#endpoint(plan, plan.viewPath, state, signal);
    } catch {
      return this.#unobserved(state, authority, signal);
    }
    // Authority/current-source checks deliberately sit outside the network error boundary.
    await this.#current(state, signal);
    await this.#grant(request, "projectMaterial:observe", state, signal);
    let response;
    try {
      response = await this.#observe.request(
        {
          method: "GET",
          target,
          headers: { "accept": "image/png", "accept-encoding": "identity" },
          maxRequestBytes: 0,
          maxResponseBytes: MAX_PROJECT_MATERIAL_BYTES,
        },
        signal,
      );
    } catch {
      return this.#unobserved(state, authority, signal);
    }
    await this.#current(state, signal);
    await this.#grant(request, "projectMaterial:observe", state, signal);
    let proof: ReturnType<typeof verifyComfyMaterialTargetBytes>;
    try {
      proof = verifyComfyMaterialTargetBytes(plan, response);
    } catch {
      if (
        response.status === 200 &&
        (state.event.phase === "dispatching" ||
          state.event.phase === "unknownOutcome")
      )
        state = await this.#advance(
          state,
          "rejected",
          null,
          "target_bytes_mismatch",
          authority,
        );
      else state = await this.#pending(state, authority);
      return this.#result(state, null, authority);
    }
    const observation = Object.freeze({ ...proof, checkedAt: this.#time() });
    if (
      state.event.phase === "dispatching" ||
      state.event.phase === "unknownOutcome"
    )
      state = await this.#advance(
        state,
        "verified",
        observation,
        null,
        authority,
      );
    else if (state.event.phase === "verified") {
      // A terminal historical observation still requires current database qualification after this new GET.
      const current = await this.#journal.load(request, authority);
      if (
        !current ||
        current.initial.contentDigest !== state.initial.contentDigest
      )
        fail("state_changed");
      state = current;
    }
    return this.#result(state, observation, authority);
  }
  async #unobserved(
    state: ProjectMaterialPreparationState,
    authority: ProjectMaterialPreparationCommitAuthority,
    signal: AbortSignal,
  ) {
    await this.#current(state, signal);
    await this.#grant(
      state.initial.request,
      "projectMaterial:observe",
      state,
      signal,
    );
    return this.#result(await this.#pending(state, authority), null, authority);
  }
  #pending(
    state: ProjectMaterialPreparationState,
    authority: ProjectMaterialPreparationCommitAuthority,
  ) {
    return state.event.phase === "dispatching"
      ? this.#advance(
          state,
          "unknownOutcome",
          null,
          "target_unobserved",
          authority,
        )
      : Promise.resolve(state);
  }
  async #advance(
    state: ProjectMaterialPreparationState,
    phase: "unknownOutcome" | "verified" | "rejected",
    observation: ProjectMaterialPreparationState["event"]["observation"],
    failureCode: string | null,
    authority: ProjectMaterialPreparationCommitAuthority,
  ) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (
        state.event.phase === "verified" ||
        state.event.phase === "rejected" ||
        (phase === "unknownOutcome" && state.event.phase === "unknownOutcome")
      )
        return state;
      try {
        return await this.#journal.advance(
          {
            request: state.initial.request,
            expectedRevision: state.event.revision,
            phase,
            observation,
            failureCode,
            at: this.#time(),
          },
          authority,
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "project_material_preparation_revision_conflict"
        )
          throw error;
        const current = await this.#journal.load(
          state.initial.request,
          authority,
        );
        if (
          !current ||
          current.initial.contentDigest !== state.initial.contentDigest
        )
          fail("state_changed");
        state = current;
      }
    }
    fail("revision_conflict");
  }
  #result(
    state: ProjectMaterialPreparationState,
    observation: ProjectMaterialPreparationState["event"]["observation"],
    authority: ProjectMaterialPreparationCommitAuthority,
  ): ProjectMaterialPreparationResult {
    this.#assertActive(authority);
    const disposition =
      state.event.phase === "rejected"
        ? "rejected"
        : observation && state.event.phase === "verified"
          ? "verified"
          : "pending";
    return Object.freeze({
      disposition,
      state,
      observation: disposition === "verified" ? observation : null,
    });
  }
  #authority(
    request: ProjectMaterialPreparationRequest,
    signal: AbortSignal,
  ): ProjectMaterialPreparationCommitAuthority {
    const check = async () => {
      await this.#grant(request, "projectMaterial:prepare", null, signal);
    };
    return Object.freeze({
      version: "crewon.project-material-preparation-commit.v1",
      request,
      assertCurrent: check,
      assertTransactionCurrent: check,
      assertActive: () => {
        signal.throwIfAborted();
        return this.#active(Object.freeze({ request }));
      },
    });
  }
  #assertActive(authority: ProjectMaterialPreparationCommitAuthority) {
    assertProjectMaterialPreparationActive(authority);
  }
  async #grant(
    request: ProjectMaterialPreparationRequest,
    action: Parameters<
      ProjectMaterialPreparationAuthorizationPort["authorize"]
    >[0]["action"],
    state: ProjectMaterialPreparationState | null,
    signal: AbortSignal,
  ) {
    const authority = this.#authority(request, signal);
    this.#assertActive(authority);
    const decision = await this.#authorize(
      Object.freeze({
        actor: request.source.actor,
        action,
        resource: Object.freeze({
          request,
          initialDigest: state?.initial.contentDigest ?? null,
          transferRequestDigest: state?.initial.transfer.requestDigest ?? null,
        }),
      }),
    );
    this.#assertActive(authority);
    if (decision.outcome !== "allow")
      throw new ApplicationError(
        "authorization",
        "project_material_preparation_denied",
      );
  }
  #time() {
    return projectAssetTimestamp(this.#now());
  }
}
function sourceInput(request: ProjectMaterialPreparationRequest) {
  return {
    query: request.source.query,
    idempotencyKey: request.source.idempotencyKey,
  };
}
function same(a: unknown, b: unknown) {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
