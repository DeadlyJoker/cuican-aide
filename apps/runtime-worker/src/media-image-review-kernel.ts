import { types } from "node:util";
import {
  AgentKernelError,
  CrewONAgentKernel,
  type AgentKernelPort,
  type AgentSegmentContract,
  type AgentSegmentRunOptions,
  type KernelAgentEvent,
} from "@crewon/agent-kernel";
import {
  MAX_PROJECT_MEDIA_IMAGE_REVIEW_BYTES,
  mediaInputSame,
  parseProjectMediaResultRequest,
  parseProjectMediaImageReviewReport,
  projectMediaImageReviewPrompt,
  assessProjectMediaImageReview,
  type ProjectMediaResultRequest,
} from "@crewon/application";
import { projectAssetDigest, projectAssetId } from "@crewon/domain";
import {
  SqliteRunStore,
  SqliteProjectMediaImageReviewJobStore,
} from "@crewon/store";
import type { ProjectMediaImageReviewJobLocator } from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { MediaImageReviewSourceReader } from "./media-image-review-source.ts";
import { MediaReviewImageError } from "./media-review-image-encoder.ts";

/** An explicitly configured, dedicated review Run, using normal Worker persistence and accounting.
 * No default Native publication or new read/send permission is created by this adapter.
 */
export class MediaImageReviewKernel implements AgentKernelPort {
  readonly modelIdentity: AgentKernelPort["modelIdentity"];
  readonly maxOutputTokens: number | undefined;
  readonly #kernel: Pick<AgentKernelPort, "runSegment">;
  readonly #sources: Pick<
    MediaImageReviewSourceReader,
    "prepare" | "source" | "observation" | "assertCurrent" | "readableCandidate"
  >;
  readonly #request: ProjectMediaResultRequest;
  readonly #candidateId: string;
  readonly #candidateDigest: string;
  readonly #runId: string;
  readonly #agentVersionId: string;
  readonly #threadId: string;
  readonly #load: SqliteRunStore["loadRunInSpace"];
  readonly #head: SqliteRunStore["loadModelHistoryHead"];
  readonly #history: SqliteRunStore["listModelHistoryItems"];
  readonly #jobs: SqliteProjectMediaImageReviewJobStore;
  readonly #originalStore: SqliteRunStore;
  /** Negative execution fence only; matching it never replaces read/send authorization. */
  matchesRunStore(run: RunState, store: SqliteRunStore): boolean {
    const actor = this.#request.actor;
    return (
      this.#originalStore === store &&
      run.runId === this.#runId &&
      run.threadId === this.#threadId &&
      run.agentVersionId === this.#agentVersionId &&
      run.tenantId === actor.tenantId &&
      run.spaceId === actor.spaceId &&
      run.createdByActorId === actor.actorId
    );
  }
  /** Restore only original persisted Native admission; report content never constructs a job. */
  static async restore(
    input: Readonly<{
      kernel: CrewONAgentKernel;
      sources: MediaImageReviewSourceReader;
      store: SqliteRunStore;
      scope: ProjectMediaImageReviewJobLocator;
      signal: AbortSignal;
    }>,
  ): Promise<MediaImageReviewKernel> {
    if (!(input.store instanceof SqliteRunStore) || types.isProxy(input.store))
      fail("dependency_invalid");
    input.signal.throwIfAborted();
    const jobs = SqliteRunStore.prototype.projectMediaImageReviewJobStore.call(
      input.store,
    );
    const job = await SqliteProjectMediaImageReviewJobStore.prototype.load.call(
      jobs,
      input.scope,
    );
    input.signal.throwIfAborted();
    if (job === null) fail("admission_missing");
    return new MediaImageReviewKernel({
      kernel: input.kernel,
      sources: input.sources,
      store: input.store,
      request: job!.request,
      candidateId: job!.candidateId,
      candidateDigest: job!.candidateDigest,
      runId: job!.runId,
      threadId: job!.threadId,
      agentVersionId: job!.agentVersionId,
    });
  }
  async #admission(signal: AbortSignal): Promise<void> {
    const actor = this.#request.actor;
    let job;
    try {
      job = await SqliteProjectMediaImageReviewJobStore.prototype.load.call(
        this.#jobs,
        {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          runId: this.#runId,
        },
      );
    } catch (cause) {
      throw new AgentKernelError(
        "media_image_review_admission_unavailable",
        false,
        { cause },
      );
    }
    signal.throwIfAborted();
    if (
      !job ||
      job.threadId !== this.#threadId ||
      job.agentVersionId !== this.#agentVersionId ||
      job.candidateId !== this.#candidateId ||
      job.candidateDigest !== this.#candidateDigest ||
      !mediaInputSame(job.request, this.#request)
    )
      fail("admission_changed");
  }
  async #qualifiedSource<T>(
    work: () => Promise<T>,
    options: Readonly<{
      signal: AbortSignal;
      stage: "prepare" | "acceptReport";
    }>,
  ): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      if (options.signal.aborted)
        throw new AgentKernelError("segment_canceled", false, { cause });
      // A busy local encoder can retry before any model dispatch. Missing source
      // authority or evidence must not silently bill another visual review.
      const busy =
        options.stage === "prepare" &&
        cause instanceof MediaReviewImageError &&
        cause.code === "media_review_image_busy";
      throw new AgentKernelError(
        busy
          ? "media_image_review_source_busy"
          : "media_image_review_source_unavailable",
        busy,
        { cause },
      );
    }
  }
  constructor(
    input: Readonly<{
      kernel: CrewONAgentKernel;
      sources: MediaImageReviewSourceReader;
      store: SqliteRunStore;
      request: ProjectMediaResultRequest;
      candidateId: string;
      candidateDigest: string;
      runId: string;
      threadId: string;
      agentVersionId: string;
    }>,
  ) {
    const prototype =
      input.store instanceof SqliteRunStore ? SqliteRunStore.prototype : null;
    if (
      !prototype ||
      types.isProxy(input.store) ||
      !(input.kernel instanceof CrewONAgentKernel) ||
      types.isProxy(input.kernel) ||
      !(input.sources instanceof MediaImageReviewSourceReader) ||
      types.isProxy(input.sources)
    )
      fail("dependency_invalid");
    this.#kernel = Object.freeze({
      runSegment: CrewONAgentKernel.prototype.runSegment.bind(input.kernel),
    });
    const sourcePrototype = MediaImageReviewSourceReader.prototype;
    this.#sources = Object.freeze({
      prepare: sourcePrototype.prepare.bind(input.sources),
      source: sourcePrototype.source.bind(input.sources),
      observation: sourcePrototype.observation.bind(input.sources),
      assertCurrent: sourcePrototype.assertCurrent.bind(input.sources),
      readableCandidate: sourcePrototype.readableCandidate.bind(input.sources),
    });
    this.#request = parseProjectMediaResultRequest(input.request);
    this.#candidateId = projectAssetId(input.candidateId);
    this.#candidateDigest = projectAssetDigest(input.candidateDigest);
    this.#runId = projectAssetId(input.runId);
    this.#threadId = projectAssetId(input.threadId);
    this.#agentVersionId = projectAssetId(input.agentVersionId);
    this.#load = prototype!.loadRunInSpace.bind(input.store);
    this.#head = prototype!.loadModelHistoryHead.bind(input.store);
    this.#history = prototype!.listModelHistoryItems.bind(input.store);
    this.#jobs = SqliteRunStore.prototype.projectMediaImageReviewJobStore.call(
      input.store,
    );
    this.#originalStore = input.store;
    this.modelIdentity = input.kernel.modelIdentity;
    this.maxOutputTokens = input.kernel.maxOutputTokens;
  }
  async #current(contract: AgentSegmentContract, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.#admission(signal);
    if (
      contract.runId !== this.#runId ||
      contract.agentVersionId !== this.#agentVersionId ||
      contract.purpose !== "agent" ||
      contract.collaborationMode !== "default" ||
      contract.reconcileCheckpoint !== undefined ||
      contract.continuation.kind !== "manual" ||
      contract.history.some((item) => item.type !== "message")
    )
      fail("run_invalid");
    const actor = this.#request.actor;
    const run = await this.#load({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      runId: this.#runId,
    });
    signal.throwIfAborted();
    if (
      run === null ||
      run.status !== "running" ||
      run.cancelRequested ||
      (run.purpose ?? "turn") !== "turn" ||
      (run.origin ?? null) !== null ||
      run.createdByActorId !== actor.actorId ||
      run.agentVersionId !== this.#agentVersionId ||
      run.threadId !== this.#threadId ||
      run.policySnapshotId !== contract.policySnapshotId ||
      run.collaborationMode !== "default"
    )
      fail("run_changed");
  }
  async *runSegment(
    contract: AgentSegmentContract,
    signal: AbortSignal,
    options?: AgentSegmentRunOptions,
  ): AsyncIterable<KernelAgentEvent> {
    // Real Worker sinks own admission, usage and cancellation; a stand-alone caller cannot quietly dispatch.
    if (
      options?.callSink === undefined ||
      options.usageSink === undefined ||
      options.controlSink === undefined ||
      options.imageObservations !== undefined
    )
      fail("accounting_required");
    await this.#current(contract, signal);
    const captured = await this.#qualifiedSource(
      () =>
        this.#sources.prepare(
          {
            scope: {
              runId: contract.runId,
              segmentId: contract.segmentId,
              agentVersionId: contract.agentVersionId,
            },
            request: this.#request,
            candidateId: this.#candidateId,
            candidateDigest: this.#candidateDigest,
          },
          { signal },
        ),
      { signal, stage: "prepare" },
    );
    await this.#current(contract, signal);
    const source = this.#sources.source(captured);
    const { emptyResponseContinuation: _durableBoundary, ...baseOptions } =
      options;
    const stream = this.#kernel.runSegment(
      {
        ...contract,
        allowedTools: [],
        runtimeTools: [],
        history: [
          ...contract.history,
          {
            type: "message",
            role: "user",
            content: projectMediaImageReviewPrompt(source),
          },
        ],
        budget: {
          maxOutputBytes: Math.min(
            contract.budget.maxOutputBytes,
            MAX_PROJECT_MEDIA_IMAGE_REVIEW_BYTES,
          ),
        },
      },
      signal,
      {
        ...baseOptions,
        imageObservations: [this.#sources.observation(captured)],
      },
    );
    for await (const event of stream) {
      if (
        event.type === "segment.continuation_requested" ||
        event.type === "tool.requested"
      )
        fail("unexpected_boundary");
      if (event.type === "segment.completed") {
        if (
          Buffer.byteLength(event.data.output) >
          MAX_PROJECT_MEDIA_IMAGE_REVIEW_BYTES
        )
          fail("report_invalid");
        try {
          parseProjectMediaImageReviewReport(
            JSON.parse(event.data.output),
            source,
          );
        } catch {
          fail("report_invalid");
        }
        await this.#qualifiedSource(
          () => this.#sources.assertCurrent(captured, { signal }),
          { signal, stage: "acceptReport" },
        );
        await this.#current(contract, signal);
      }
      yield event;
    }
  }
  /** Uses the same immutable admission after restart; source permissions remain independently required. */
  async loadCompletedReport(options: Readonly<{ signal: AbortSignal }>) {
    await this.#admission(options.signal);
    const actor = this.#request.actor;
    const candidate = await this.#sources.readableCandidate(
      this.#request,
      options,
    );
    if (
      candidate.candidateId !== this.#candidateId ||
      candidate.contentDigest !== this.#candidateDigest
    )
      return Object.freeze({ state: "stale" as const });
    const run = await this.#load({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      runId: this.#runId,
    });
    options.signal.throwIfAborted();
    if (
      run === null ||
      run.status !== "completed" ||
      run.createdByActorId !== actor.actorId ||
      run.threadId !== this.#threadId ||
      run.agentVersionId !== this.#agentVersionId ||
      (run.purpose ?? "turn") !== "turn" ||
      (run.origin ?? null) !== null
    )
      fail("report_not_completed");
    const locator = { tenantId: actor.tenantId, threadId: this.#threadId };
    const head = await this.#head(locator);
    options.signal.throwIfAborted();
    if (head === null) fail("report_missing");
    const history = await this.#history(
      locator,
      Math.max(0, head.lastSequence - 128),
      128,
    );
    options.signal.throwIfAborted();
    const completions = history.filter(
      (item) =>
        item.type === "message" &&
        item.role === "assistant" &&
        item.source === "assistant_completion" &&
        item.runId === this.#runId,
    );
    if (completions.length !== 1 || completions[0]!.type !== "message")
      fail("report_missing");
    const content = completions[0]!.content;
    if (Buffer.byteLength(content) > MAX_PROJECT_MEDIA_IMAGE_REVIEW_BYTES)
      fail("report_invalid");
    let report;
    try {
      report = parseProjectMediaImageReviewReport(JSON.parse(content));
    } catch {
      return fail("report_invalid");
    }
    if (
      report.source.reviewRunId !== this.#runId ||
      report.source.reviewerAgentVersionId !== this.#agentVersionId ||
      report.source.projectId !== this.#request.query.projectId ||
      report.source.generationRunId !== this.#request.query.runId ||
      report.source.resultIndex !== this.#request.query.resultIndex ||
      report.source.candidateId !== this.#candidateId ||
      report.source.candidateDigest !== this.#candidateDigest ||
      report.source.originalByteDigest !== candidate.frozen.source.byteDigest
    )
      return Object.freeze({ state: "stale" as const });
    const settled = await this.#sources.readableCandidate(
      this.#request,
      options,
    );
    if (settled.contentDigest !== candidate.contentDigest)
      return Object.freeze({ state: "stale" as const });
    return Object.freeze({
      state: "ready" as const,
      report,
      assessment: assessProjectMediaImageReview(report, report.source),
    });
  }
}
function fail(code: string): never {
  throw new AgentKernelError(`media_image_review_${code}`, false);
}
