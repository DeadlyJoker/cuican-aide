import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import { parseProjectSourceUploadPartLocator } from "./project-source-uploads-contract.ts";
import { parsePublicProjectSourceUpload } from "./project-source-uploads-public-contract.ts";
import {
  uploadContractChecked,
  uploadContractEnum,
  uploadContractFail,
  uploadContractNumber,
} from "./project-source-uploads-contract-support.ts";
import {
  MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  type ProjectSourceUploadMutationResponse,
  type ProjectSourceUploadPartLocator,
} from "./project-source-uploads-service.ts";

/** Acknowledges these exact transmitted bytes. It contains no capability or private byte-store identity. */
export function parseProjectSourceUploadPartResponse(
  input: unknown,
  locatorInput: ProjectSourceUploadPartLocator,
  transmittedByteLength: number,
): ProjectSourceUploadMutationResponse {
  return uploadContractChecked(() => {
    const locator = parseProjectSourceUploadPartLocator(locatorInput);
    const byteLength = uploadContractNumber(
      transmittedByteLength,
      1,
      PROJECT_SOURCE_UPLOAD_PART_BYTES,
    );
    const value = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
      }),
      ["disposition", "upload"],
    );
    const disposition = uploadContractEnum(value.disposition, [
      "committed",
      "replayed",
    ]);
    const upload = parsePublicProjectSourceUpload(value.upload);
    const part = upload.receivedParts.find(
      (candidate) => candidate.index === locator.partIndex,
    );
    if (
      upload.uploadId !== locator.uploadId ||
      upload.phase !== "receiving" ||
      part === undefined ||
      part.byteLength !== byteLength ||
      part.rawDigest !== locator.rawDigest
    )
      uploadContractFail();
    return Object.freeze({ disposition, upload });
  });
}
