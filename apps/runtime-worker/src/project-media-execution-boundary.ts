import { types } from "node:util";
import {
  MEDIA_GENERATION_ACTION,
  PROJECT_MEDIA_OPERATION_VERSION,
  mediaInputSame,
  type ExternalOperation,
  type ExternalOperationStore,
  type ProjectMediaOperationState,
} from "@crewon/application";
import {
  SqliteExternalOperationStore,
  PostgresExternalOperationStore,
} from "@crewon/store";
import type {
  PluginToolRuntimeContext,
  PluginJsonHttpSubmission,
} from "@crewon/plugin-sdk/node";
import {
  ProjectMediaRunContext,
  type ProjectMediaRunSnapshot,
} from "./project-media-run-context.ts";
import {
  InstalledPluginRunContext,
  type InstalledPluginRunSnapshot,
  type InstalledPluginRunPurpose,
} from "./plugins/installed-plugin-run-context.ts";
import {
  captureProjectMediaExecutionReview,
  expectedProjectMediaSubmission,
  mediaExecutionDigest,
  mediaExecutionFail as fail,
  type ProjectMediaExecutionReview,
} from "./project-media-execution-review.ts";

/** Private composition for the original Tool IO owner. Data and persisted slots never grant dispatch. */
export class ProjectMediaExecutionBoundary {
  readonly context: PluginToolRuntimeContext;
  readonly operations: ExternalOperationStore;
  readonly #scope: { tenantId: string; runId: string; bindingDigest: string };
  readonly #read: SqliteExternalOperationStore["loadProjectMediaOperation"];
  readonly #enabled: () => boolean;
  readonly #installed: InstalledPluginRunSnapshot;
  readonly #mediaLoad: ProjectMediaRunContext["load"];
  readonly #prepare: ProjectMediaRunContext["prepareSubmit"];
  readonly #observe: ProjectMediaRunContext["readObservation"];
  readonly #current: ProjectMediaRunContext["assertCurrent"];
  readonly #target: ProjectMediaRunContext["verifiedExecutionTarget"];
  readonly #reviews: readonly ProjectMediaExecutionReview[];
  #snapshot: ProjectMediaRunSnapshot | null = null;
  constructor(
    input: Readonly<{
      installed: InstalledPluginRunContext;
      snapshot: InstalledPluginRunSnapshot;
      media: ProjectMediaRunContext;
      operations: SqliteExternalOperationStore | PostgresExternalOperationStore;
      reviews: readonly ProjectMediaExecutionReview[];
    }>,
  ) {
    const proto =
      input.operations instanceof SqliteExternalOperationStore
        ? SqliteExternalOperationStore.prototype
        : input.operations instanceof PostgresExternalOperationStore
          ? PostgresExternalOperationStore.prototype
          : null;
    if (
      !proto ||
      !(input.installed instanceof InstalledPluginRunContext) ||
      !(input.media instanceof ProjectMediaRunContext) ||
      [input.operations, input.installed, input.media, input.snapshot].some(
        (v) => types.isProxy(v),
      )
    )
      fail("dependency_invalid");
    const admission =
      InstalledPluginRunContext.prototype.verifiedTaskAdmission.call(
        input.installed,
        input.snapshot,
      );
    ProjectMediaRunContext.prototype.assertInstalledReader.call(
      input.media,
      input.installed,
    );
    if (
      admission.pluginId !== "crewon.short-drama" ||
      admission.action !== MEDIA_GENERATION_ACTION ||
      input.snapshot.context.run.source !== null
    )
      fail("scope_invalid");
    this.#installed = input.snapshot;
    this.context = input.snapshot.context;
    this.#scope = {
      tenantId: admission.tenantId,
      runId: admission.runId,
      bindingDigest: admission.extensionBindingDigest,
    };
    const version = Object.getOwnPropertyDescriptor(
      proto,
      "projectMediaOperationsVersion",
    )!;
    this.#enabled = () =>
      Reflect.apply(version.get!, input.operations, []) ===
      PROJECT_MEDIA_OPERATION_VERSION;
    if (!this.#enabled()) fail("unavailable");
    this.#read = proto.loadProjectMediaOperation.bind(input.operations);
    this.operations = Object.freeze({
      reserveExternalOperation: proto.reserveExternalOperation.bind(
        input.operations,
      ),
      loadExternalOperation: proto.loadExternalOperation.bind(input.operations),
      advanceExternalOperation: proto.advanceExternalOperation.bind(
        input.operations,
      ),
    });
    this.#mediaLoad = ProjectMediaRunContext.prototype.load.bind(input.media);
    this.#prepare = ProjectMediaRunContext.prototype.prepareSubmit.bind(
      input.media,
    );
    this.#observe = ProjectMediaRunContext.prototype.readObservation.bind(
      input.media,
    );
    this.#current = ProjectMediaRunContext.prototype.assertCurrent.bind(
      input.media,
    );
    this.#target =
      ProjectMediaRunContext.prototype.verifiedExecutionTarget.bind(
        input.media,
      );
    if (
      !Array.isArray(input.reviews) ||
      !input.reviews.length ||
      input.reviews.length > 32
    )
      fail("review_invalid");
    this.#reviews = Object.freeze(
      input.reviews.map(captureProjectMediaExecutionReview),
    );
    Object.freeze(this);
  }
  async #media(purpose: InstalledPluginRunPurpose, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.#enabled()) fail("unavailable");
    if (!this.#snapshot) {
      const value = await this.#mediaLoad(this.#installed, { purpose, signal });
      if (!value) fail("scope_invalid");
      this.#snapshot = value;
    }
    await this.#current(this.#snapshot, { purpose, signal });
    return this.#snapshot;
  }
  async readOperation(
    signal: AbortSignal,
  ): Promise<ProjectMediaOperationState | null> {
    signal.throwIfAborted();
    if (!this.#enabled()) fail("unavailable");
    const state = await this.#read(this.#scope);
    signal.throwIfAborted();
    if (state) await this.#media("observe", signal);
    return state;
  }
  async hasOperation(signal: AbortSignal): Promise<boolean> {
    return (await this.readOperation(signal)) !== null;
  }
  async readInput(signal: AbortSignal) {
    const state = await this.readOperation(signal);
    const media = await this.#media(state ? "observe" : "submit", signal);
    if (state) {
      const observation = await this.#observe(media, { signal });
      if (
        state.link.executionId !== observation.reference.executionId ||
        state.link.projectId !== observation.reference.projectId
      )
        fail("operation_mismatch");
      return Object.freeze({
        kind: "existing" as const,
        ...observation,
        operation: state.operation,
      });
    }
    const prepared = await this.#prepare(media, { signal });
    this.#review(media);
    return Object.freeze({
      kind: "new" as const,
      reference: media.reference,
      ...prepared,
    });
  }
  async readObservation(signal: AbortSignal) {
    const state = await this.readOperation(signal);
    const media = await this.#media("observe", signal);
    if (!state) return null;
    const observation = await this.#observe(media, { signal });
    if (
      state.link.executionId !== observation.reference.executionId ||
      state.link.projectId !== observation.reference.projectId
    )
      fail("operation_mismatch");
    return Object.freeze({
      kind: "existing" as const,
      ...observation,
      operation: state.operation,
    });
  }
  #review(media: ProjectMediaRunSnapshot) {
    const target = this.#target(media),
      reviews = this.#reviews.filter(
        (r) =>
          mediaInputSame(r.targetIdentity, target) &&
          mediaInputSame(r.workflow, media.workflow),
      );
    if (reviews.length !== 1) fail("review_mismatch");
    return reviews[0]!;
  }
  async assertSubmission(
    request: PluginJsonHttpSubmission,
    operationId: string,
    configuredOrigin: string,
    signal: AbortSignal,
  ) {
    const media = await this.#media("submit", signal),
      prepared = await this.#prepare(media, { signal }),
      review = this.#review(media);
    if (
      new URL(prepared.targetServiceOrigin).origin !== configuredOrigin ||
      mediaExecutionDigest(request) !==
        mediaExecutionDigest(
          expectedProjectMediaSubmission(review, prepared, operationId),
        )
    )
      fail("submission_mismatch");
    signal.throwIfAborted();
  }
  /** Received provider evidence may persist after late revocation; this check grants no new IO. */
  async assertOperationIdentity(operation: ExternalOperation) {
    if (!this.#enabled()) fail("unavailable");
    const state = await this.#read(this.#scope);
    if (
      !state ||
      state.operation.operationId !== operation.operationId ||
      Object.entries(state.link.reservation).some(
        ([k, v]) => operation[k as keyof ExternalOperation] !== v,
      )
    )
      fail("operation_mismatch");
  }
  async assertOperation(
    operation: ExternalOperation,
    purpose: InstalledPluginRunPurpose,
    signal: AbortSignal,
  ) {
    await this.assertOperationIdentity(operation);
    await this.#media(purpose, signal);
  }
}

export function captureProjectMediaExecutionBoundary(
  input: ProjectMediaExecutionBoundary,
  context: PluginToolRuntimeContext,
  operations: ExternalOperationStore,
) {
  if (
    !(input instanceof ProjectMediaExecutionBoundary) ||
    types.isProxy(input) ||
    operations !== input.operations ||
    !mediaInputSame(context, input.context)
  )
    fail("dependency_invalid");
  const p = ProjectMediaExecutionBoundary.prototype;
  return Object.freeze({
    readInput: p.readInput.bind(input),
    readObservation: p.readObservation.bind(input),
    readOperation: p.readOperation.bind(input),
    hasOperation: p.hasOperation.bind(input),
    assertSubmission: p.assertSubmission.bind(input),
    assertOperation: p.assertOperation.bind(input),
    assertOperationIdentity: p.assertOperationIdentity.bind(input),
  });
}
