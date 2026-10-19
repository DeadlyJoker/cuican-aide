import {
  projectAssetDigest,
  projectAssetId,
  projectAssetTimestamp,
} from "@crewon/domain";
import {
  mediaInputData,
  mediaInputDigest,
  mediaInputSame,
} from "./project-media-input-record.ts";
import { materialPreparationFields as fields } from "./project-material-preparation-record.ts";
import { parseProjectMediaResultRequest } from "./project-media-result-record.ts";
import type { ProjectMediaResultRequest } from "./project-media-result-port.ts";

export type ProjectMediaImageReviewJob = Readonly<{
  schemaVersion: "crewon.project-media-image-review-job.v1";
  request: ProjectMediaResultRequest;
  candidateId: string;
  candidateDigest: string;
  originalByteDigest: string;
  runId: string;
  threadId: string;
  agentVersionId: string;
  authorityId: string;
  runtimeGeneration: string;
  policySnapshotId: string;
  transformation: "png-to-jpeg-white-v1";
  createdAt: string;
  contentDigest: string;
}>;
export type ProjectMediaImageReviewJobLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  runId: string;
}>;

export function parseProjectMediaImageReviewJob(
  input: unknown,
): ProjectMediaImageReviewJob {
  const v = fields(mediaInputData(input, 8192), [
    "schemaVersion",
    "request",
    "candidateId",
    "candidateDigest",
    "originalByteDigest",
    "runId",
    "threadId",
    "agentVersionId",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "transformation",
    "createdAt",
    "contentDigest",
  ]);
  if (
    v.schemaVersion !== "crewon.project-media-image-review-job.v1" ||
    v.transformation !== "png-to-jpeg-white-v1"
  )
    throw new Error("project_media_image_review_job_invalid");
  const body = Object.freeze({
    schemaVersion: "crewon.project-media-image-review-job.v1" as const,
    request: parseProjectMediaResultRequest(v.request),
    candidateId: projectAssetId(v.candidateId),
    candidateDigest: projectAssetDigest(v.candidateDigest),
    originalByteDigest: projectAssetDigest(v.originalByteDigest),
    runId: projectAssetId(v.runId),
    threadId: projectAssetId(v.threadId),
    agentVersionId: projectAssetId(v.agentVersionId),
    authorityId: projectAssetId(v.authorityId),
    runtimeGeneration: projectAssetId(v.runtimeGeneration),
    policySnapshotId: projectAssetId(v.policySnapshotId),
    transformation: "png-to-jpeg-white-v1" as const,
    createdAt: projectAssetTimestamp(v.createdAt),
  });
  const contentDigest = projectAssetDigest(v.contentDigest);
  if (contentDigest !== mediaInputDigest(body))
    throw new Error("project_media_image_review_job_invalid");
  const job = Object.freeze({ ...body, contentDigest });
  if (Buffer.byteLength(JSON.stringify(job)) > 8192)
    throw new Error("project_media_image_review_job_invalid");
  return job;
}
export function createProjectMediaImageReviewJob(
  input: Omit<
    ProjectMediaImageReviewJob,
    "schemaVersion" | "transformation" | "contentDigest"
  >,
) {
  const body = {
    ...fields(mediaInputData(input, 8192), [
      "request",
      "candidateId",
      "candidateDigest",
      "originalByteDigest",
      "runId",
      "threadId",
      "agentVersionId",
      "authorityId",
      "runtimeGeneration",
      "policySnapshotId",
      "createdAt",
    ]),
    schemaVersion: "crewon.project-media-image-review-job.v1" as const,
    transformation: "png-to-jpeg-white-v1" as const,
  };
  return parseProjectMediaImageReviewJob({
    ...body,
    contentDigest: mediaInputDigest(body),
  });
}
export function sameProjectMediaImageReviewJobIntent(
  a: ProjectMediaImageReviewJob,
  b: ProjectMediaImageReviewJob,
): boolean {
  const {
    runId: _aRun,
    createdAt: _aAt,
    contentDigest: _aDigest,
    ...aIntent
  } = a;
  const {
    runId: _bRun,
    createdAt: _bAt,
    contentDigest: _bDigest,
    ...bIntent
  } = b;
  return mediaInputSame(aIntent, bIntent);
}
