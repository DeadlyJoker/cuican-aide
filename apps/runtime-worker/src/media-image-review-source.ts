import { types } from "node:util";
import {
  captureModelImageObservation,
  type ModelImageObservation,
  type ModelImageScope,
} from "@crewon/agent-kernel";
import {
  ApplicationError,
  mediaInputDigest,
  mediaInputSame,
  parseProjectMediaResultRequest,
  parseProjectMediaImageReviewSource,
  projectMediaInputBound,
  type AuthorizationDecision,
  type ProjectMediaResultRequest,
  type ProjectMediaImageReviewSource,
} from "@crewon/application";
import { projectAssetDigest, projectAssetId } from "@crewon/domain";
import { ProjectMediaResultPublisher } from "@crewon/media-runtime/project-media-result-publisher";
import { MediaReviewImageEncoder } from "./media-review-image-encoder.ts";

export type MediaImageReviewPermission = Readonly<{
  action: "projectMediaImageReview:send";
  request: ProjectMediaResultRequest;
  source: ProjectMediaImageReviewSource;
}>;
/** Independent model transmission approval; an artifact read is insufficient. */
export type MediaImageReviewAuthorization = Readonly<{
  authorize(
    permission: MediaImageReviewPermission,
  ): Promise<AuthorizationDecision>;
  assertActive(permission: MediaImageReviewPermission): void;
}>;
export type PreparedMediaImageReview = Readonly<{
  kind: "prepared-media-image-review";
  sourceDigest: string;
}>;
type Prepared = Readonly<{
  owner: MediaImageReviewSourceReader;
  request: ProjectMediaResultRequest;
  source: ProjectMediaImageReviewSource;
  observation: ModelImageObservation;
}>;
const prepared = new WeakMap<PreparedMediaImageReview, Prepared>();
function fail(code: string): never {
  throw new ApplicationError("authorization", `media_image_review_${code}`);
}

/** Reads an exact encrypted candidate, derives pixels locally, and rechecks read/send permissions. */
export class MediaImageReviewSourceReader {
  readonly #read: ProjectMediaResultPublisher["readCandidate"];
  readonly #encode: MediaReviewImageEncoder["encodePng"];
  readonly #authorization: MediaImageReviewAuthorization;
  constructor(
    input: Readonly<{
      results: ProjectMediaResultPublisher;
      encoder: MediaReviewImageEncoder;
      authorization: MediaImageReviewAuthorization;
    }>,
  ) {
    if (
      !(input.results instanceof ProjectMediaResultPublisher) ||
      types.isProxy(input.results) ||
      !(input.encoder instanceof MediaReviewImageEncoder) ||
      types.isProxy(input.encoder)
    )
      fail("dependency_invalid");
    this.#read = ProjectMediaResultPublisher.prototype.readCandidate.bind(
      input.results,
    );
    this.#encode = MediaReviewImageEncoder.prototype.encodePng.bind(
      input.encoder,
    );
    this.#authorization = Object.freeze({
      authorize: projectMediaInputBound<
        MediaImageReviewAuthorization["authorize"]
      >(input.authorization, "authorize"),
      assertActive: projectMediaInputBound<
        MediaImageReviewAuthorization["assertActive"]
      >(input.authorization, "assertActive"),
    });
  }
  async prepare(
    input: Readonly<{
      scope: ModelImageScope;
      request: ProjectMediaResultRequest;
      candidateId: string;
      candidateDigest: string;
    }>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<PreparedMediaImageReview> {
    const request = parseProjectMediaResultRequest(input.request);
    const candidateId = projectAssetId(input.candidateId),
      candidateDigest = projectAssetDigest(input.candidateDigest);
    options.signal.throwIfAborted();
    const content = await this.#read(request.actor, request.query, options);
    if (
      content === null ||
      content.candidate.candidateId !== candidateId ||
      content.candidate.contentDigest !== candidateDigest
    )
      fail("candidate_changed");
    options.signal.throwIfAborted();
    const bytes = await this.#encode(content.bytes, options);
    options.signal.throwIfAborted();
    const observation = captureModelImageObservation({
      scope: input.scope,
      evidenceId: "candidate-image",
      mediaType: "image/jpeg",
      bytes,
      detail: "high",
    });
    const source = parseProjectMediaImageReviewSource({
      reviewRunId: input.scope.runId,
      reviewerAgentVersionId: input.scope.agentVersionId,
      projectId: request.query.projectId,
      generationRunId: request.query.runId,
      resultIndex: request.query.resultIndex,
      candidateId,
      candidateDigest,
      originalByteDigest: content.candidate.frozen.source.byteDigest,
      image: {
        transformation: "png-to-jpeg-white-v1",
        evidenceId: observation.evidenceId,
        contentDigest: observation.contentDigest,
        width: observation.width,
        height: observation.height,
      },
    });
    const token = Object.freeze({
      kind: "prepared-media-image-review" as const,
      sourceDigest: mediaInputDigest(source),
    });
    prepared.set(
      token,
      Object.freeze({ owner: this, request, source, observation }),
    );
    await MediaImageReviewSourceReader.prototype.assertCurrent.call(
      this,
      token,
      options,
    );
    return token;
  }
  #require(token: PreparedMediaImageReview): Prepared {
    const capture = prepared.get(token);
    if (capture === undefined || capture.owner !== this)
      fail("prepared_input_invalid");
    return capture;
  }
  observation(token: PreparedMediaImageReview) {
    return this.#require(token).observation;
  }
  source(token: PreparedMediaImageReview) {
    return this.#require(token).source;
  }
  /** Synchronous host grant fence for the original SQLite Turn transaction. */
  assertPreparedActive(token: PreparedMediaImageReview): void {
    const capture = this.#require(token);
    this.#authorization.assertActive(
      Object.freeze({
        action: "projectMediaImageReview:send" as const,
        request: capture.request,
        source: capture.source,
      }),
    );
  }
  /** Reading a saved report reuses candidate read permission; it sends nothing to a model. */
  async readableCandidate(
    requestInput: ProjectMediaResultRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    const request = parseProjectMediaResultRequest(requestInput);
    options.signal.throwIfAborted();
    const content = await this.#read(request.actor, request.query, options);
    options.signal.throwIfAborted();
    if (content === null) fail("candidate_missing");
    return content.candidate;
  }
  async assertCurrent(
    token: PreparedMediaImageReview,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<void> {
    const capture = this.#require(token);
    options.signal.throwIfAborted();
    const permission = Object.freeze({
      action: "projectMediaImageReview:send" as const,
      request: capture.request,
      source: capture.source,
    });
    this.#authorization.assertActive(permission);
    const decision = await this.#authorization.authorize(permission);
    options.signal.throwIfAborted();
    if (decision.outcome !== "allow") fail("send_denied");
    const current = await this.#read(
      capture.request.actor,
      capture.request.query,
      options,
    );
    options.signal.throwIfAborted();
    if (
      current === null ||
      current.candidate.candidateId !== capture.source.candidateId ||
      current.candidate.contentDigest !== capture.source.candidateDigest ||
      current.candidate.frozen.source.byteDigest !==
        capture.source.originalByteDigest ||
      !mediaInputSame(current.candidate.frozen.request, capture.request)
    )
      fail("candidate_changed");
    this.#authorization.assertActive(permission);
  }
}
