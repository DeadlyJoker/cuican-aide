import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectSourceUploadPartResponse,
  type ProjectSourceUploadMutationResponse,
} from "./project-source-uploads.ts";

const digest = `sha256:${"a".repeat(64)}`;
const locator = {
  uploadId: "original-upload",
  partIndex: 0,
  rawDigest: digest,
};
const acknowledgement: ProjectSourceUploadMutationResponse = {
  disposition: "committed",
  upload: {
    uploadId: locator.uploadId,
    revision: 2,
    phase: "receiving",
    fileName: "story.txt",
    format: "txt",
    byteLength: 65_539,
    fileDigest: `sha256:${"b".repeat(64)}`,
    partBytes: 65_536,
    partCount: 2,
    receivedParts: [{ index: 0, byteLength: 65_536, rawDigest: digest }],
    prepared: null,
    failureCode: null,
    updatedAt: "2026-10-08T00:00:00.000Z",
  },
};

test("raw part acknowledgement binds the exact upload, index, digest and physical length", () => {
  const result = parseProjectSourceUploadPartResponse(
    acknowledgement,
    locator,
    65_536,
  );
  assert.deepEqual(result, acknowledgement);
  assert.notEqual(result, acknowledgement);
  assert.ok(Object.isFrozen(result.upload.receivedParts[0]));
  assert.deepEqual(
    parseProjectSourceUploadPartResponse(
      { ...acknowledgement, disposition: "replayed" },
      locator,
      65_536,
    ),
    { ...acknowledgement, disposition: "replayed" },
  );
  const last = {
    ...acknowledgement,
    upload: {
      ...acknowledgement.upload,
      revision: 3,
      receivedParts: [
        ...acknowledgement.upload.receivedParts,
        { index: 1, byteLength: 3, rawDigest: digest },
      ],
    },
  };
  assert.deepEqual(
    parseProjectSourceUploadPartResponse(last, { ...locator, partIndex: 1 }, 3),
    last,
  );
});

test("foreign, missing, changed, oversized and non-write responses do not acknowledge a part", () => {
  for (const response of [
    { ...acknowledgement, taskId: "invented" },
    { ...acknowledgement, disposition: "pending" },
    {
      ...acknowledgement,
      upload: { ...acknowledgement.upload, owner: "private" },
    },
    {
      ...acknowledgement,
      upload: { ...acknowledgement.upload, uploadId: "foreign" },
    },
    {
      ...acknowledgement,
      upload: { ...acknowledgement.upload, receivedParts: [] },
    },
    {
      ...acknowledgement,
      upload: {
        ...acknowledgement.upload,
        receivedParts: [
          {
            index: 0,
            byteLength: 65_536,
            rawDigest: `sha256:${"c".repeat(64)}`,
          },
        ],
      },
    },
    {
      ...acknowledgement,
      upload: { ...acknowledgement.upload, phase: "cancelled", revision: 3 },
    },
  ])
    assert.throws(
      () => parseProjectSourceUploadPartResponse(response, locator, 65_536),
      { code: "project_source_upload_contract_invalid" },
    );
  for (const byteLength of [0, -1, 0.5, 3, 65_537, NaN])
    assert.throws(
      () =>
        parseProjectSourceUploadPartResponse(
          acknowledgement,
          locator,
          byteLength,
        ),
      { code: "project_source_upload_contract_invalid" },
    );
  assert.throws(
    () =>
      parseProjectSourceUploadPartResponse(
        acknowledgement,
        { ...locator, partIndex: 1 },
        65_536,
      ),
    { code: "project_source_upload_contract_invalid" },
  );
  const getter = Object.defineProperty({}, "disposition", {
    enumerable: true,
    get: () => {
      throw new Error("accessor must not execute");
    },
  });
  assert.throws(
    () => parseProjectSourceUploadPartResponse(getter, locator, 65_536),
    { code: "project_source_upload_contract_invalid" },
  );
});
