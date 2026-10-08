import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import {
  creativeControlDigest,
  creativeControlId,
} from "./creative-project-control-support.ts";
import {
  uploadContractChecked,
  uploadContractEnum,
  uploadContractFail,
  uploadContractFileName,
  uploadContractNumber,
} from "./project-source-uploads-contract-support.ts";
import { parsePublicProjectSourceUpload } from "./project-source-uploads-public-contract.ts";
import {
  MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES,
  MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
  PROJECT_SOURCE_UPLOAD_MAX_BYTES,
  PROJECT_SOURCE_UPLOAD_MAX_PARTS,
  PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS as actions,
  isProjectSourceUploadAction,
  type ProjectSourceUploadMethod,
  type ProjectSourceUploadPartLocator,
  type ProjectSourceUploadRequest,
  type ProjectSourceUploadResponseFor,
} from "./project-source-uploads-service.ts";

function method(action: unknown): ProjectSourceUploadMethod {
  if (!isProjectSourceUploadAction(action)) uploadContractFail();
  const result = (Object.keys(actions) as ProjectSourceUploadMethod[]).find(
    (key) => actions[key] === action,
  );
  if (result === undefined) uploadContractFail();
  return result;
}
export function parseProjectSourceUploadRequest(
  input: unknown,
): ProjectSourceUploadRequest {
  return uploadContractChecked(() => {
    const outer = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES,
      }),
      ["action", "input"],
    );
    const selected = method(outer.action);
    const value = pluginUiFields(
      outer.input,
      selected === "begin"
        ? ["idempotencyKey", "fileName", "format", "byteLength", "fileDigest"]
        : selected === "status"
          ? ["uploadId"]
          : ["uploadId", "expectedRevision"],
    );
    if (selected === "begin") {
      const format = uploadContractEnum(value.format, ["txt", "md", "html"]);
      return Object.freeze({
        action: actions.begin,
        input: Object.freeze({
          idempotencyKey: creativeControlId(value.idempotencyKey),
          fileName: uploadContractFileName(value.fileName, format),
          format,
          byteLength: uploadContractNumber(
            value.byteLength,
            1,
            PROJECT_SOURCE_UPLOAD_MAX_BYTES,
          ),
          fileDigest: creativeControlDigest(value.fileDigest),
        }),
      });
    }
    const uploadId = creativeControlId(value.uploadId);
    if (selected === "status")
      return Object.freeze({
        action: actions.status,
        input: Object.freeze({ uploadId }),
      });
    return Object.freeze({
      action: actions[selected],
      input: Object.freeze({
        uploadId,
        expectedRevision: uploadContractNumber(value.expectedRevision),
      }),
    });
  });
}
export function parseProjectSourceUploadResponse<
  R extends ProjectSourceUploadRequest,
>(input: unknown, expected: R): ProjectSourceUploadResponseFor<R> {
  return uploadContractChecked(() => {
    const request = parseProjectSourceUploadRequest(expected);
    const value = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
      }),
      request.action === actions.status
        ? ["upload"]
        : ["disposition", "upload"],
    );
    const upload = parsePublicProjectSourceUpload(value.upload);
    if (
      "uploadId" in request.input &&
      upload.uploadId !== request.input.uploadId
    )
      uploadContractFail();
    if (request.action === actions.status)
      return Object.freeze({ upload }) as ProjectSourceUploadResponseFor<R>;
    if (request.action === actions.prepare) {
      const disposition = uploadContractEnum(value.disposition, [
        "ready",
        "pending",
        "rejected",
      ]);
      if (
        upload.phase !== (disposition === "pending" ? "preparing" : disposition)
      )
        uploadContractFail();
      return Object.freeze({
        disposition,
        upload,
      }) as ProjectSourceUploadResponseFor<R>;
    }
    const disposition = uploadContractEnum(value.disposition, [
      "committed",
      "replayed",
    ]);
    if (request.action === actions.begin) {
      for (const field of [
        "fileName",
        "format",
        "byteLength",
        "fileDigest",
      ] as const)
        if (upload[field] !== request.input[field]) uploadContractFail();
      if (
        disposition === "committed" &&
        (upload.phase !== "receiving" ||
          upload.revision !== 1 ||
          upload.receivedParts.length !== 0)
      )
        uploadContractFail();
    } else if (
      upload.phase !== "cancelled" ||
      (disposition === "committed" &&
        upload.revision !== request.input.expectedRevision + 1)
    )
      uploadContractFail();
    return Object.freeze({
      disposition,
      upload,
    }) as ProjectSourceUploadResponseFor<R>;
  });
}

export function parseProjectSourceUploadPartLocator(
  input: unknown,
): ProjectSourceUploadPartLocator {
  return uploadContractChecked(() => {
    const value = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES,
      }),
      ["uploadId", "partIndex", "rawDigest"],
    );
    return Object.freeze({
      uploadId: creativeControlId(value.uploadId),
      partIndex: uploadContractNumber(
        value.partIndex,
        0,
        PROJECT_SOURCE_UPLOAD_MAX_PARTS - 1,
      ),
      rawDigest: creativeControlDigest(value.rawDigest),
    });
  });
}
/** Canonical path only. Digest is a lowercase hex segment; this declares no HTTP route. */
export function projectSourceUploadPartPath(
  mountRef: string,
  input: ProjectSourceUploadPartLocator,
): string {
  return uploadContractChecked(() => {
    const mount = creativeControlId(mountRef),
      locator = parseProjectSourceUploadPartLocator(input);
    return `/api/v1/plugins/ui/mounts/${encodeURIComponent(mount)}/source-uploads/${encodeURIComponent(locator.uploadId)}/parts/${locator.partIndex}/${locator.rawDigest.slice(7)}`;
  });
}
export function parseProjectSourceUploadPartPath(
  input: unknown,
): Readonly<{ mountRef: string; locator: ProjectSourceUploadPartLocator }> {
  return uploadContractChecked(() => {
    if (
      typeof input !== "string" ||
      input.length > MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES
    )
      uploadContractFail();
    const matches =
      /^\/api\/v1\/plugins\/ui\/mounts\/([^/?#]+)\/source-uploads\/([^/?#]+)\/parts\/(0|[1-9][0-9]{0,2})\/([a-f0-9]{64})$/u.exec(
        input,
      );
    if (matches === null) uploadContractFail();
    const mountRef = creativeControlId(decodeURIComponent(matches[1]!));
    const locator = parseProjectSourceUploadPartLocator({
      uploadId: decodeURIComponent(matches[2]!),
      partIndex: Number(matches[3]),
      rawDigest: "sha256:" + matches[4],
    });
    if (projectSourceUploadPartPath(mountRef, locator) !== input)
      uploadContractFail();
    return Object.freeze({ mountRef, locator });
  });
}
