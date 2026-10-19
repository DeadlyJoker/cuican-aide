import { types } from "node:util";
import { projectAssetId, extensionCanonicalJson } from "@crewon/domain";
import {
  TurnApplicationService,
  createProjectMediaImageReviewJob,
  parseProjectMediaResultRequest,
  sameProjectMediaImageReviewJobIntent,
  type StartTurnCommand,
  type ProjectMediaResultRequest,
} from "@crewon/application";
import {
  SqliteRunStore,
  SqliteProjectMediaImageReviewJobStore,
} from "@crewon/store";
import { MediaImageReviewSourceReader } from "./media-image-review-source.ts";

/** Native host entry, with a host-pinned review route. No plugin or model supplies routing authority. */
export class MediaImageReviewJobService {
  readonly #turns: TurnApplicationService;
  readonly #sources: MediaImageReviewSourceReader;
  readonly #jobs: SqliteProjectMediaImageReviewJobStore;
  readonly #route: StartTurnCommand["route"];
  constructor(
    input: Readonly<{
      store: SqliteRunStore;
      turns: TurnApplicationService;
      sources: MediaImageReviewSourceReader;
      route: StartTurnCommand["route"];
    }>,
  ) {
    if (
      !(input.store instanceof SqliteRunStore) ||
      types.isProxy(input.store) ||
      !(input.turns instanceof TurnApplicationService) ||
      types.isProxy(input.turns) ||
      !(input.sources instanceof MediaImageReviewSourceReader) ||
      types.isProxy(input.sources) ||
      input.route.workspaceBindingId !== null
    )
      throw new Error("media_image_review_job_dependency_invalid");
    this.#turns = input.turns;
    this.#sources = input.sources;
    this.#jobs = SqliteRunStore.prototype.projectMediaImageReviewJobStore.call(
      input.store,
    );
    this.#route = Object.freeze({
      authorityId: projectAssetId(input.route.authorityId),
      runtimeGeneration: projectAssetId(input.route.runtimeGeneration),
      agentVersionId: projectAssetId(input.route.agentVersionId),
      policySnapshotId: projectAssetId(input.route.policySnapshotId),
      workspaceBindingId: null,
    });
  }
  async start(
    input: Readonly<{
      request: ProjectMediaResultRequest;
      candidateId: string;
      candidateDigest: string;
      threadId: string;
      expectedThreadRevision: number;
      idempotencyKey: string;
    }>,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    options.signal.throwIfAborted();
    const request = parseProjectMediaResultRequest(input.request);
    const candidate =
      await MediaImageReviewSourceReader.prototype.readableCandidate.call(
        this.#sources,
        request,
        options,
      );
    if (
      candidate.candidateId !== input.candidateId ||
      candidate.contentDigest !== input.candidateDigest
    )
      throw new Error("media_image_review_job_candidate_changed");
    const command: StartTurnCommand = {
      kind: "turn.start",
      threadId: projectAssetId(input.threadId),
      expectedThreadRevision: input.expectedThreadRevision,
      content:
        "Review only this saved candidate.\n" +
        extensionCanonicalJson({
          request,
          candidateId: candidate.candidateId,
          candidateDigest: candidate.contentDigest,
          originalByteDigest: candidate.frozen.source.byteDigest,
          route: this.#route,
        }),
      requestedAgentVersionId: this.#route.agentVersionId,
      executionIntent: "none",
      toolPermissionMode: "requestApproval",
      idempotencyKey: input.idempotencyKey,
      route: this.#route,
    };
    const facts = {
      request,
      candidateId: candidate.candidateId,
      candidateDigest: candidate.contentDigest,
      originalByteDigest: candidate.frozen.source.byteDigest,
      threadId: command.threadId,
      agentVersionId: this.#route.agentVersionId,
      authorityId: this.#route.authorityId,
      runtimeGeneration: this.#route.runtimeGeneration,
      policySnapshotId: this.#route.policySnapshotId,
    };
    const replay = await TurnApplicationService.prototype.replayTurn.call(
      this.#turns,
      request.actor,
      command,
    );
    options.signal.throwIfAborted();
    if (replay !== null) {
      const saved =
        await SqliteProjectMediaImageReviewJobStore.prototype.load.call(
          this.#jobs,
          {
            tenantId: request.actor.tenantId,
            spaceId: request.actor.spaceId,
            runId: replay.runState.runId,
          },
        );
      if (
        !saved ||
        !sameProjectMediaImageReviewJobIntent(
          saved,
          createProjectMediaImageReviewJob({
            ...facts,
            runId: saved.runId,
            createdAt: saved.createdAt,
          }),
        )
      )
        throw new Error("media_image_review_job_replay_missing_or_changed");
      options.signal.throwIfAborted();
      // Replaying an accepted receipt never needs a new model-send grant or encoding job.
      return Object.freeze({ turn: replay, job: saved });
    }
    const turn = await TurnApplicationService.prototype.prepareTurn.call(
      this.#turns,
      request.actor,
      command,
    );
    const event = turn.run.events[0];
    if (event?.type !== "run.created")
      throw new Error("media_image_review_job_turn_invalid");
    const runId = event.identity.runId;
    const prepared = await MediaImageReviewSourceReader.prototype.prepare.call(
      this.#sources,
      {
        scope: {
          runId,
          segmentId: `admission:${runId}`,
          agentVersionId: this.#route.agentVersionId,
        },
        request,
        candidateId: candidate.candidateId,
        candidateDigest: candidate.contentDigest,
      },
      options,
    );
    const source = MediaImageReviewSourceReader.prototype.source.call(
      this.#sources,
      prepared,
    );
    if (source.originalByteDigest !== facts.originalByteDigest)
      throw new Error("media_image_review_job_candidate_changed");
    options.signal.throwIfAborted();
    return SqliteProjectMediaImageReviewJobStore.prototype.commit.call(
      this.#jobs,
      {
        turn,
        job: createProjectMediaImageReviewJob({
          ...facts,
          runId,
          createdAt: event.occurredAt,
        }),
        assertActive: () => {
          options.signal.throwIfAborted();
          MediaImageReviewSourceReader.prototype.assertPreparedActive.call(
            this.#sources,
            prepared,
          );
        },
      },
    );
  }
}
