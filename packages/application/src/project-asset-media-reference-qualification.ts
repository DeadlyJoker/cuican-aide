import {
  parseProjectAssetMediaImageSource,
  projectAssetId,
  projectAssetDigest,
  projectAssetRevision,
  type ProjectAsset,
  type ProjectAssetRevision,
  type ProjectAssetMediaImageSource,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ProjectMediaInputRevision } from "./project-media-input-port.ts";
import type {
  ProjectMediaResultCandidate,
  ProjectMediaResultAuthority,
  ProjectMediaResultRequest,
} from "./project-media-result-port.ts";
import { materialPreparationFields as fields } from "./project-material-preparation-record.ts";
import {
  mediaInputData,
  mediaInputSame,
  parseProjectMediaInputRevision,
} from "./project-media-input-record.ts";
import {
  parseProjectMediaResultRequest,
  parseProjectMediaResultCandidate,
} from "./project-media-result-record.ts";

export type ProjectAssetMediaReferenceQualificationRequest = Readonly<{
  actor: ActorContext;
  query: Readonly<{
    projectId: string;
    runId: string;
    resultIndex: number;
    candidateId: string;
    candidateDigest: string;
    assetId: string;
    expectedAssetRevision: number;
    assetContentRevision: number;
  }>;
}>;
/** Point-in-time metadata, not adoption authority. A future write must reprove it on its own connection. */
export type QualifiedProjectAssetMediaReference = Readonly<{
  asset: ProjectAsset;
  content: ProjectAssetRevision;
  source: ProjectAssetMediaImageSource;
}>;
export interface ProjectAssetMediaReferenceQualificationStore {
  qualifyAssetReference(
    request: ProjectAssetMediaReferenceQualificationRequest,
    authority: ProjectMediaResultAuthority,
  ): Promise<QualifiedProjectAssetMediaReference>;
}

export function parseProjectAssetMediaReferenceQualificationRequest(
  input: unknown,
): ProjectAssetMediaReferenceQualificationRequest {
  const r = fields(mediaInputData(input, 4096), ["actor", "query"]),
    q = fields(r.query, [
      "projectId",
      "runId",
      "resultIndex",
      "candidateId",
      "candidateDigest",
      "assetId",
      "expectedAssetRevision",
      "assetContentRevision",
    ]),
    base = parseProjectMediaResultRequest({
      actor: r.actor,
      query: {
        projectId: q.projectId,
        runId: q.runId,
        resultIndex: q.resultIndex,
      },
    });
  if (
    typeof q.candidateId !== "string" ||
    !/^result-[a-f0-9]{64}$/u.test(q.candidateId)
  )
    invalid("candidate_invalid");
  return Object.freeze({
    actor: base.actor,
    query: Object.freeze({
      ...base.query,
      candidateId: q.candidateId,
      candidateDigest: projectAssetDigest(q.candidateDigest),
      assetId: projectAssetId(q.assetId),
      expectedAssetRevision: projectAssetRevision(q.expectedAssetRevision),
      assetContentRevision: projectAssetRevision(q.assetContentRevision),
    }),
  });
}
export function projectAssetMediaReferenceResultRequest(
  request: ProjectAssetMediaReferenceQualificationRequest,
): ProjectMediaResultRequest {
  const { actor, query: q } =
    parseProjectAssetMediaReferenceQualificationRequest(request);
  return parseProjectMediaResultRequest({
    actor,
    query: {
      projectId: q.projectId,
      runId: q.runId,
      resultIndex: q.resultIndex,
    },
  });
}

/** Caller must load both records from the original Run/operation history on one Store connection. */
export function projectAssetMediaImageSourceFromResult(
  candidateInput: ProjectMediaResultCandidate,
  inputValue: ProjectMediaInputRevision,
): ProjectAssetMediaImageSource {
  const candidate = parseProjectMediaResultCandidate(candidateInput),
    input = parseProjectMediaInputRevision(inputValue),
    frozen = candidate.frozen,
    source = frozen.source.projection,
    ref = source.reference,
    target = input.target;
  if (
    source.item.kind !== "character-reference" ||
    input.item.kind !== "character-reference" ||
    source.workflow.workflowId !== "krea2-reference-four-view" ||
    input.workflow.workflowId !== "krea2-reference-four-view"
  )
    invalid("purpose_mismatch");
  if (
    !mediaInputSame(source.request.actor, input.actor) ||
    !mediaInputSame(source.workflow, input.workflow) ||
    !mediaInputSame(source.item, input.item) ||
    ref.projectId !== input.projectId ||
    ref.mediaInputId !== input.mediaInputId ||
    ref.inputRevision !== input.inputRevision ||
    ref.mediaInputDigest !== input.contentDigest ||
    source.targetIdentity.pluginId !== target.package.pluginId ||
    source.targetIdentity.version !== target.package.version ||
    source.targetIdentity.publisherId !== target.package.publisherId ||
    source.targetIdentity.packageDigest !== target.package.packageDigest ||
    source.targetIdentity.manifestDigest !==
      target.configuration.manifestDigest ||
    source.targetIdentity.implementationDigest !==
      target.configuration.implementationDigest ||
    source.configuration.revision !== target.configuration.revision ||
    source.configuration.contentDigest !== target.configuration.contentDigest
  )
    invalid("history_changed");
  const original = input.references[0]!,
    query = original.preparation.source.query;
  if (
    input.references.length !== 1 ||
    original.role !== "character" ||
    query.assetId !== source.item.assetId ||
    query.kind !== "character"
  )
    invalid("purpose_mismatch");
  return parseProjectAssetMediaImageSource({
    schemaVersion: "crewon.project-asset-media-image-source.v1",
    kind: "media-result",
    candidateId: candidate.candidateId,
    candidateDigest: candidate.contentDigest,
    sourceDigest: source.contentDigest,
    sourceRunId: source.request.query.runId,
    resultIndex: source.request.query.resultIndex,
    mediaInputId: ref.mediaInputId,
    inputRevision: ref.inputRevision,
    executionId: ref.executionId,
    workflowId: source.workflow.workflowId,
    generationDigest: source.generationDigest,
    operationLinkDigest: source.operationLinkDigest,
    operationId: source.operation.operationId,
    operationRevision: source.operation.revision,
    operationDigest: source.operation.contentDigest,
    pluginId: source.targetIdentity.pluginId,
    pluginVersion: source.targetIdentity.version,
    packageDigest: source.targetIdentity.packageDigest,
    configurationRevision: source.configuration.revision,
    configurationDigest: source.configuration.contentDigest,
    generatedFor: {
      assetId: query.assetId,
      contentRevision: query.contentRevision,
      contentDigest: original.contentDigest,
      referenceRevision: query.referenceRevision,
      referenceDigest: original.referenceDigest,
    },
    observedAt: frozen.source.observedAt,
  });
}
function invalid(code: string): never {
  throw new ApplicationError(
    "conflict",
    `project_asset_media_reference_${code}`,
  );
}
