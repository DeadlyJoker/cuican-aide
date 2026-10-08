import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import {
  creativeControlDigest,
  creativeControlId,
  creativeControlTimestamp,
} from "./creative-project-control-support.ts";
import {
  uploadContractChecked,
  uploadContractEnum,
  uploadContractFail,
  uploadContractFileName,
  uploadContractNumber,
} from "./project-source-uploads-contract-support.ts";
import {
  MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  PROJECT_SOURCE_UPLOAD_MAX_BYTES,
  PROJECT_SOURCE_UPLOAD_MAX_PARTS,
  type PublicProjectSourceUpload,
  type PublicProjectSourceUploadPrepared,
} from "./project-source-uploads-service.ts";

export function parsePublicProjectSourceUpload(
  input: unknown,
): PublicProjectSourceUpload {
  return uploadContractChecked(() => {
    const value = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
      }),
      [
        "uploadId",
        "revision",
        "phase",
        "fileName",
        "format",
        "byteLength",
        "fileDigest",
        "partBytes",
        "partCount",
        "receivedParts",
        "prepared",
        "failureCode",
        "updatedAt",
      ],
    );
    const format = uploadContractEnum(value.format, ["txt", "md", "html"]);
    const phase = uploadContractEnum(value.phase, [
      "receiving",
      "raw-sealed",
      "preparing",
      "ready",
      "rejected",
      "cancelled",
      "expired",
    ]);
    const byteLength = uploadContractNumber(
      value.byteLength,
      1,
      PROJECT_SOURCE_UPLOAD_MAX_BYTES,
    );
    const partCount = uploadContractNumber(
      value.partCount,
      1,
      PROJECT_SOURCE_UPLOAD_MAX_PARTS,
    );
    if (
      value.partBytes !== PROJECT_SOURCE_UPLOAD_PART_BYTES ||
      partCount !== Math.ceil(byteLength / PROJECT_SOURCE_UPLOAD_PART_BYTES) ||
      !Array.isArray(value.receivedParts) ||
      value.receivedParts.length > partCount
    )
      uploadContractFail();
    let previousIndex = -1;
    const receivedParts = Object.freeze(
      value.receivedParts.map((input) => {
        const part = pluginUiFields(input, [
          "index",
          "byteLength",
          "rawDigest",
        ]);
        const index = uploadContractNumber(part.index, 0, partCount - 1);
        const expectedLength = Math.min(
          PROJECT_SOURCE_UPLOAD_PART_BYTES,
          byteLength - index * PROJECT_SOURCE_UPLOAD_PART_BYTES,
        );
        if (index <= previousIndex || part.byteLength !== expectedLength)
          uploadContractFail();
        previousIndex = index;
        return Object.freeze({
          index,
          byteLength: expectedLength,
          rawDigest: creativeControlDigest(part.rawDigest),
        });
      }),
    );
    const revision = uploadContractNumber(value.revision);
    let minimumRevision = receivedParts.length + 1;
    if (["raw-sealed", "preparing", "ready", "rejected"].includes(phase)) {
      if (receivedParts.length !== partCount) uploadContractFail();
      minimumRevision +=
        phase === "raw-sealed" ? 1 : phase === "preparing" ? 2 : 3;
    } else if (phase === "cancelled" || phase === "expired") minimumRevision++;
    if (revision < minimumRevision) uploadContractFail();
    const prepared =
      value.prepared === null ? null : preparation(value.prepared);
    if ((phase === "ready") !== (prepared !== null)) uploadContractFail();
    const failureCode =
      value.failureCode === null ? null : creativeControlId(value.failureCode);
    if ((phase === "rejected") !== (failureCode !== null)) uploadContractFail();
    return Object.freeze({
      uploadId: creativeControlId(value.uploadId),
      revision,
      phase,
      fileName: uploadContractFileName(value.fileName, format),
      format,
      byteLength,
      fileDigest: creativeControlDigest(value.fileDigest),
      partBytes: PROJECT_SOURCE_UPLOAD_PART_BYTES,
      partCount,
      receivedParts,
      prepared,
      failureCode,
      updatedAt: creativeControlTimestamp(value.updatedAt),
    });
  });
}
function preparation(input: unknown): PublicProjectSourceUploadPrepared {
  const p = pluginUiFields(input, [
    "digest",
    "characterLength",
    "normalizedByteLength",
    "chunkCount",
    "chapterCount",
  ]);
  const characterLength = uploadContractNumber(
    p.characterLength,
    1,
    PROJECT_SOURCE_UPLOAD_MAX_BYTES,
  );
  const normalizedByteLength = uploadContractNumber(
    p.normalizedByteLength,
    1,
    PROJECT_SOURCE_UPLOAD_MAX_BYTES,
  );
  const chunkCount = uploadContractNumber(p.chunkCount, 1, 20_000);
  const chapterCount = uploadContractNumber(p.chapterCount, 0, 20_000);
  if (
    characterLength > normalizedByteLength ||
    chunkCount > characterLength ||
    chapterCount > characterLength ||
    normalizedByteLength > chunkCount * 4096
  )
    uploadContractFail();
  return Object.freeze({
    digest: creativeControlDigest(p.digest),
    characterLength,
    normalizedByteLength,
    chunkCount,
    chapterCount,
  });
}
