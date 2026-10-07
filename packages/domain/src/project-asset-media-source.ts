import {
  projectAssetChecked,
  projectAssetDigest,
  projectAssetFailure,
  projectAssetId,
  projectAssetRecord,
  projectAssetRevision,
  projectAssetTimestamp,
} from "./project-asset-validation.ts";
import { pluginInstallationVersion } from "./plugin-installation-validation.ts";

/** A distinct media origin. Never encode a media result as an old concept selection. */
export type ProjectAssetMediaImageSource = Readonly<{
  schemaVersion: "crewon.project-asset-media-image-source.v1";
  kind: "media-result";
  candidateId: string;
  candidateDigest: string;
  sourceDigest: string;
  sourceRunId: string;
  resultIndex: number;
  mediaInputId: string;
  inputRevision: number;
  executionId: string;
  workflowId: "krea2-reference-four-view";
  generationDigest: string;
  operationLinkDigest: string;
  operationId: string;
  operationRevision: number;
  operationDigest: string;
  pluginId: "crewon.short-drama";
  pluginVersion: string;
  packageDigest: string;
  configurationRevision: number;
  configurationDigest: string;
  generatedFor: Readonly<{
    assetId: string;
    contentRevision: number;
    contentDigest: string;
    referenceRevision: number;
    referenceDigest: string;
  }>;
  observedAt: string;
}>;

/** Metadata validation is not read, commit, adoption or image-byte authority. */
export function parseProjectAssetMediaImageSource(
  input: unknown,
): ProjectAssetMediaImageSource {
  return projectAssetChecked(() => {
    const v = projectAssetRecord(input, [
        "schemaVersion",
        "kind",
        "candidateId",
        "candidateDigest",
        "sourceDigest",
        "sourceRunId",
        "resultIndex",
        "mediaInputId",
        "inputRevision",
        "executionId",
        "workflowId",
        "generationDigest",
        "operationLinkDigest",
        "operationId",
        "operationRevision",
        "operationDigest",
        "pluginId",
        "pluginVersion",
        "packageDigest",
        "configurationRevision",
        "configurationDigest",
        "generatedFor",
        "observedAt",
      ]),
      target = projectAssetRecord(v.generatedFor, [
        "assetId",
        "contentRevision",
        "contentDigest",
        "referenceRevision",
        "referenceDigest",
      ]);
    if (
      v.schemaVersion !== "crewon.project-asset-media-image-source.v1" ||
      v.kind !== "media-result" ||
      v.workflowId !== "krea2-reference-four-view" ||
      v.pluginId !== "crewon.short-drama" ||
      typeof v.candidateId !== "string" ||
      !/^result-[a-f0-9]{64}$/u.test(v.candidateId) ||
      typeof v.operationId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
        v.operationId,
      ) ||
      !Number.isSafeInteger(v.resultIndex) ||
      (v.resultIndex as number) < 0 ||
      (v.resultIndex as number) > 15
    )
      projectAssetFailure("project_asset_media_source_invalid");
    return Object.freeze({
      schemaVersion: "crewon.project-asset-media-image-source.v1" as const,
      kind: "media-result" as const,
      candidateId: v.candidateId,
      candidateDigest: projectAssetDigest(v.candidateDigest),
      sourceDigest: projectAssetDigest(v.sourceDigest),
      sourceRunId: projectAssetId(v.sourceRunId),
      resultIndex: v.resultIndex as number,
      mediaInputId: projectAssetId(v.mediaInputId),
      inputRevision: projectAssetRevision(v.inputRevision),
      executionId: projectAssetId(v.executionId),
      workflowId: "krea2-reference-four-view" as const,
      generationDigest: projectAssetDigest(v.generationDigest),
      operationLinkDigest: projectAssetDigest(v.operationLinkDigest),
      operationId: v.operationId,
      operationRevision: projectAssetRevision(v.operationRevision),
      operationDigest: projectAssetDigest(v.operationDigest),
      pluginId: "crewon.short-drama" as const,
      pluginVersion: pluginInstallationVersion(v.pluginVersion),
      packageDigest: projectAssetDigest(v.packageDigest),
      configurationRevision: projectAssetRevision(v.configurationRevision),
      configurationDigest: projectAssetDigest(v.configurationDigest),
      generatedFor: Object.freeze({
        assetId: projectAssetId(target.assetId),
        contentRevision: projectAssetRevision(target.contentRevision),
        contentDigest: projectAssetDigest(target.contentDigest),
        referenceRevision: projectAssetRevision(target.referenceRevision),
        referenceDigest: projectAssetDigest(target.referenceDigest),
      }),
      observedAt: projectAssetTimestamp(v.observedAt),
    });
  });
}
