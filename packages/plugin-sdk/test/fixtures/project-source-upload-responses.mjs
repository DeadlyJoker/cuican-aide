export const uploadDigest = `sha256:${"a".repeat(64)}`;
export const uploadId = "independent-upload";
export const partLocator = Object.freeze({
  uploadId,
  partIndex: 0,
  rawDigest: uploadDigest,
});
export const uploadBeginInput = Object.freeze({
  idempotencyKey: "stable-source-upload",
  fileName: "story.txt",
  format: "txt",
  byteLength: 7,
  fileDigest: uploadDigest,
});
export const upload = Object.freeze({
  uploadId,
  revision: 1,
  phase: "receiving",
  fileName: "story.txt",
  format: "txt",
  byteLength: 7,
  fileDigest: uploadDigest,
  partBytes: 65_536,
  partCount: 1,
  receivedParts: [],
  prepared: null,
  failureCode: null,
  updatedAt: "2026-10-08T08:00:00.000Z",
});
export const writtenUpload = Object.freeze({
  ...upload,
  revision: 2,
  receivedParts: [{ index: 0, byteLength: 7, rawDigest: uploadDigest }],
});
export const rawSealedUpload = Object.freeze({
  ...writtenUpload,
  revision: 3,
  phase: "raw-sealed",
});
export const readyUpload = Object.freeze({
  ...rawSealedUpload,
  revision: 5,
  phase: "ready",
  prepared: {
    digest: uploadDigest,
    characterLength: 7,
    normalizedByteLength: 7,
    chunkCount: 1,
    chapterCount: 0,
  },
});
export const cancelledUpload = Object.freeze({
  ...upload,
  revision: 2,
  phase: "cancelled",
});
export const uploadVectors = Object.freeze([
  ["begin", uploadBeginInput, { disposition: "committed", upload }],
  ["status", { uploadId }, { upload }],
  [
    "prepare",
    { uploadId, expectedRevision: 3 },
    { disposition: "ready", upload: readyUpload },
  ],
  [
    "cancel",
    { uploadId, expectedRevision: 1 },
    { disposition: "committed", upload: cancelledUpload },
  ],
]);
