import assert from "node:assert/strict";
import test from "node:test";
import {
  CREWON_PROJECT_SOURCE_UPLOAD_API_VERSION,
  CREWON_PROJECT_SOURCE_UPLOAD_SERVICE,
  MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES,
  MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
  PROJECT_SOURCE_UPLOAD_MAX_BYTES,
  PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS as actions,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  ProjectSourceUploadContractError,
  isProjectSourceUploadAction,
  parseProjectSourceUploadPartLocator,
  parseProjectSourceUploadPartPath,
  parseProjectSourceUploadRequest,
  parseProjectSourceUploadResponse,
  parsePublicProjectSourceUpload,
  projectSourceUploadPartPath,
  projectSourceUploadsCodec,
  type ProjectSourceUploadInputMap,
  type ProjectSourceUploadMethod,
  type ProjectSourceUploadPhase,
  type ProjectSourceUploadRequestFor,
  type PublicProjectSourceUpload,
} from "./project-source-uploads.ts";

const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const at = "2026-10-08T00:00:00.000Z";
const beginInput: ProjectSourceUploadInputMap["begin"] = {
  idempotencyKey: "begin-1",
  fileName: "故事.txt",
  format: "txt",
  byteLength: 7,
  fileDigest: digest,
};
function request<M extends ProjectSourceUploadMethod>(
  method: M,
  input: ProjectSourceUploadInputMap[M],
): ProjectSourceUploadRequestFor<M> {
  return { action: actions[method], input };
}
function upload(
  phase: ProjectSourceUploadPhase = "receiving",
  patch: Partial<PublicProjectSourceUpload> = {},
): PublicProjectSourceUpload {
  const complete = ["raw-sealed", "preparing", "ready", "rejected"].includes(
    phase,
  );
  const revision = {
    "receiving": 1,
    "raw-sealed": 3,
    "preparing": 4,
    "ready": 5,
    "rejected": 5,
    "cancelled": 2,
    "expired": 2,
  }[phase];
  return {
    uploadId: "upload-1",
    revision,
    phase,
    fileName: beginInput.fileName,
    format: beginInput.format,
    byteLength: beginInput.byteLength,
    fileDigest: beginInput.fileDigest,
    partBytes: PROJECT_SOURCE_UPLOAD_PART_BYTES,
    partCount: 1,
    receivedParts: complete
      ? [{ index: 0, byteLength: 7, rawDigest: digest }]
      : [],
    prepared:
      phase === "ready"
        ? {
            digest: otherDigest,
            characterLength: 3,
            normalizedByteLength: 7,
            chunkCount: 1,
            chapterCount: 0,
          }
        : null,
    failureCode:
      phase === "rejected" ? "project_source_import_encoding_invalid" : null,
    updatedAt: at,
    ...patch,
  };
}
function invalid(run: () => unknown) {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof ProjectSourceUploadContractError &&
      error.code === "project_source_upload_contract_invalid",
  );
}

test("upload protocol uses its independent frozen four-action namespace", () => {
  assert.equal(
    CREWON_PROJECT_SOURCE_UPLOAD_SERVICE,
    "crewon.project-source-uploads",
  );
  assert.equal(CREWON_PROJECT_SOURCE_UPLOAD_API_VERSION, "1");
  assert.equal(MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES, 8192);
  assert.equal(MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES, 61440);
  assert.equal(Object.isFrozen(actions), true);
  assert.equal(Object.isFrozen(projectSourceUploadsCodec), true);
  for (const method of ["begin", "status", "prepare", "cancel"] as const)
    assert.equal(isProjectSourceUploadAction(actions[method]), true);
  assert.equal(
    isProjectSourceUploadAction("crewon.project-foundation.v1.createProject"),
    false,
  );
});

test("all four commands detach and freeze data before later caller changes", () => {
  const raw = request("begin", { ...beginInput });
  const parsed = projectSourceUploadsCodec.parseRequest(raw);
  (raw.input as { fileName: string }).fileName = "changed.txt";
  assert.equal(
    (parsed.input as ProjectSourceUploadInputMap["begin"]).fileName,
    "故事.txt",
  );
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.input), true);
  for (const method of ["status", "prepare", "cancel"] as const) {
    const input =
      method === "status"
        ? { uploadId: "upload-1" }
        : { uploadId: "upload-1", expectedRevision: 2 };
    assert.deepEqual(
      parseProjectSourceUploadRequest(request(method, input)),
      request(method, input),
    );
  }
});

test("begin validates original-byte bounds and the declared file format", () => {
  for (const [format, fileName] of [
    ["txt", "故事.TXT"],
    ["md", "故事.markdown"],
    ["html", "故事.htm"],
  ] as const) {
    assert.equal(
      parseProjectSourceUploadRequest(
        request("begin", {
          ...beginInput,
          format,
          fileName,
          byteLength: PROJECT_SOURCE_UPLOAD_MAX_BYTES,
        }),
      ).action,
      actions.begin,
    );
  }
  for (const patch of [
    { byteLength: 0 },
    { byteLength: 20_000_001 },
    { byteLength: 1.5 },
    { byteLength: NaN },
    { fileDigest: `sha256:${"A".repeat(64)}` },
    { fileName: "../story.txt" },
    { fileName: "story\\book.txt" },
    { fileName: "story\n.txt" },
    { fileName: "story.txt " },
    { fileName: "story.md" },
    { fileName: "\ud800.txt" },
    { fileName: "x".repeat(252) + ".txt" },
    { idempotencyKey: ".." },
  ])
    invalid(() =>
      parseProjectSourceUploadRequest({
        action: actions.begin,
        input: { ...beginInput, ...patch },
      }),
    );
});

test("JSON commands cannot carry raw bytes, source bodies or claimed identities", () => {
  for (const field of [
    "owner",
    "tenantId",
    "principalId",
    "realmId",
    "rawBytes",
    "base64",
    "chunks",
    "prepared",
    "sourceUpload",
  ]) {
    invalid(() =>
      parseProjectSourceUploadRequest({
        action: actions.begin,
        input: { ...beginInput, [field]: "private" },
      }),
    );
    invalid(() =>
      parseProjectSourceUploadRequest({
        ...request("status", { uploadId: "upload-1" }),
        [field]: "private",
      }),
    );
  }
  invalid(() =>
    parseProjectSourceUploadRequest({
      action: "crewon.project-foundation.v1.begin",
      input: beginInput,
    }),
  );
  invalid(() =>
    parseProjectSourceUploadRequest(
      request("prepare", {
        uploadId: "upload-1",
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      }),
    ),
  );
  invalid(() =>
    parseProjectSourceUploadRequest({
      action: actions.status,
      input: { uploadId: "upload-1", expectedRevision: 1 },
    }),
  );
});

test("descriptor validation never invokes getters or serialization hooks", () => {
  let calls = 0;
  const accessor = Object.defineProperty({ action: actions.begin }, "input", {
    enumerable: true,
    get() {
      calls++;
      return beginInput;
    },
  });
  invalid(() => parseProjectSourceUploadRequest(accessor));
  invalid(() =>
    parseProjectSourceUploadRequest({
      ...request("begin", beginInput),
      toJSON() {
        calls++;
        return {};
      },
    }),
  );
  const hidden = Object.defineProperty(request("begin", beginInput), "hidden", {
    value: true,
  });
  invalid(() => parseProjectSourceUploadRequest(hidden));
  invalid(() =>
    parseProjectSourceUploadRequest({
      ...request("begin", beginInput),
      [Symbol("secret")]: true,
    }),
  );
  invalid(() =>
    parseProjectSourceUploadRequest(
      Object.assign(
        Object.create({ inherited: true }),
        request("begin", beginInput),
      ),
    ),
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  invalid(() => parseProjectSourceUploadRequest(revoked.proxy));
  assert.equal(calls, 0);
});

test("receiving projection supports acknowledged out-of-order part indexes", () => {
  const raw = upload("receiving", {
    byteLength: 65_543,
    partCount: 2,
    revision: 2,
    receivedParts: [{ index: 1, byteLength: 7, rawDigest: digest }],
  });
  const parsed = parsePublicProjectSourceUpload(raw);
  (raw.receivedParts[0] as { byteLength: number }).byteLength = 6;
  assert.equal(parsed.receivedParts[0]!.byteLength, 7);
  assert.equal(Object.isFrozen(parsed.receivedParts), true);
  assert.equal(Object.isFrozen(parsed.receivedParts[0]), true);
});

test("each actual phase has a bounded projection with its terminal information", () => {
  for (const phase of [
    "receiving",
    "raw-sealed",
    "preparing",
    "ready",
    "rejected",
    "cancelled",
    "expired",
  ] as const) {
    assert.deepEqual(
      parsePublicProjectSourceUpload(upload(phase)),
      upload(phase),
    );
  }
  assert.equal(
    Object.isFrozen(parsePublicProjectSourceUpload(upload("ready")).prepared),
    true,
  );
});

test("part count, lengths, ordering and completion are checked against original bytes", () => {
  for (const patch of [
    { partCount: 2 },
    { partBytes: 64 },
    { revision: 0 },
    {
      receivedParts: [{ index: 0, byteLength: 6, rawDigest: digest }],
      revision: 2,
    },
    {
      receivedParts: [{ index: 1, byteLength: 7, rawDigest: digest }],
      revision: 2,
    },
    {
      receivedParts: [
        { index: 0, byteLength: 7, rawDigest: digest },
        { index: 0, byteLength: 7, rawDigest: digest },
      ],
      revision: 3,
    },
  ])
    invalid(() => parsePublicProjectSourceUpload({ ...upload(), ...patch }));
  invalid(() =>
    parsePublicProjectSourceUpload(upload("raw-sealed", { receivedParts: [] })),
  );
  invalid(() =>
    parsePublicProjectSourceUpload(upload("preparing", { revision: 3 })),
  );
  invalid(() =>
    parsePublicProjectSourceUpload(upload("ready", { revision: 4 })),
  );
  invalid(() =>
    parsePublicProjectSourceUpload(upload("cancelled", { revision: 1 })),
  );
  invalid(() =>
    parsePublicProjectSourceUpload(upload("expired", { revision: 1 })),
  );
  const reversed = [
    { index: 1, byteLength: 7, rawDigest: digest },
    { index: 0, byteLength: 65_536, rawDigest: digest },
  ];
  invalid(() =>
    parsePublicProjectSourceUpload(
      upload("receiving", {
        byteLength: 65_543,
        partCount: 2,
        revision: 3,
        receivedParts: reversed,
      }),
    ),
  );
  const sparse = new Array(1);
  invalid(() =>
    parsePublicProjectSourceUpload(
      upload("receiving", { receivedParts: sparse, revision: 2 }),
    ),
  );
});

test("prepared metrics cannot invent a ready body or exceed canonical storage limits", () => {
  const base = upload("ready");
  for (const patch of [
    { characterLength: 0 },
    { characterLength: 8 },
    { normalizedByteLength: 20_000_001 },
    { normalizedByteLength: 4097 },
    { chunkCount: 0 },
    { chunkCount: 20_001 },
    { chunkCount: 4 },
    { chapterCount: -1 },
    { chapterCount: 4 },
    { digest: "bad" },
    { parserVersion: "private" },
  ])
    invalid(() =>
      parsePublicProjectSourceUpload({
        ...base,
        prepared: { ...base.prepared, ...patch },
      }),
    );
  invalid(() =>
    parsePublicProjectSourceUpload(upload("ready", { prepared: null })),
  );
  invalid(() =>
    parsePublicProjectSourceUpload(
      upload("receiving", { prepared: base.prepared }),
    ),
  );
  // UTF-16 and HTML normalization may expand UTF-8 beyond original bytes.
  assert.equal(
    parsePublicProjectSourceUpload(
      upload("ready", {
        prepared: { ...base.prepared!, normalizedByteLength: 12 },
      }),
    ).prepared!.normalizedByteLength,
    12,
  );
});

test("only rejected projection carries failure and canonical audit timestamp is required", () => {
  invalid(() =>
    parsePublicProjectSourceUpload(upload("rejected", { failureCode: null })),
  );
  invalid(() =>
    parsePublicProjectSourceUpload(
      upload("ready", { failureCode: "internal" }),
    ),
  );
  invalid(() =>
    parsePublicProjectSourceUpload(
      upload("rejected", { failureCode: "\nserver-path" }),
    ),
  );
  for (const updatedAt of [
    "2026-10-08",
    "2026-10-08T00:00:00Z",
    "2026-02-30T00:00:00.000Z",
  ])
    invalid(() =>
      parsePublicProjectSourceUpload(upload("receiving", { updatedAt })),
    );
});

test("public upload projection hides all internal provenance and body fields", () => {
  for (const field of [
    "owner",
    "storageRealmId",
    "tenantId",
    "actorId",
    "normalizationParserVersion",
    "claim",
    "sealed",
    "sourceUpload",
    "rawBytes",
    "text",
  ])
    invalid(() =>
      parsePublicProjectSourceUpload({ ...upload(), [field]: "private" }),
    );
  invalid(() =>
    parsePublicProjectSourceUpload(
      upload("ready", {
        prepared: { ...upload("ready").prepared!, pointer: "private" },
      } as unknown as Partial<PublicProjectSourceUpload>),
    ),
  );
  invalid(() =>
    parsePublicProjectSourceUpload({
      ...upload("raw-sealed"),
      receivedParts: [
        { index: 0, byteLength: 7, rawDigest: digest, byteOffset: 0 },
      ],
    }),
  );
});

test("begin replay preserves actual later phase but cannot substitute metadata", () => {
  const expected = request("begin", beginInput);
  assert.equal(
    parseProjectSourceUploadResponse(
      { disposition: "committed", upload: upload() },
      expected,
    ).disposition,
    "committed",
  );
  for (const phase of ["ready", "cancelled", "rejected"] as const)
    assert.equal(
      parseProjectSourceUploadResponse(
        { disposition: "replayed", upload: upload(phase) },
        expected,
      ).upload.phase,
      phase,
    );
  invalid(() =>
    parseProjectSourceUploadResponse(
      { disposition: "committed", upload: upload("ready") },
      expected,
    ),
  );
  invalid(() =>
    parseProjectSourceUploadResponse(
      {
        disposition: "replayed",
        upload: upload("ready", { fileDigest: otherDigest }),
      },
      expected,
    ),
  );
  invalid(() =>
    parseProjectSourceUploadResponse(
      {
        disposition: "replayed",
        upload: upload("ready", { fileName: "other.txt" }),
      },
      expected,
    ),
  );
});

test("status response pins the requested upload and has no mutation disposition", () => {
  const expected = request("status", { uploadId: "upload-1" });
  assert.deepEqual(
    parseProjectSourceUploadResponse({ upload: upload() }, expected),
    { upload: upload() },
  );
  invalid(() =>
    parseProjectSourceUploadResponse(
      { upload: upload("receiving", { uploadId: "other" }) },
      expected,
    ),
  );
  invalid(() =>
    parseProjectSourceUploadResponse(
      { disposition: "replayed", upload: upload() },
      expected,
    ),
  );
});

test("prepare disposition represents actual ready, pending or rejected service state", () => {
  const expected = request("prepare", {
    uploadId: "upload-1",
    expectedRevision: 2,
  });
  for (const [disposition, phase] of [
    ["ready", "ready"],
    ["pending", "preparing"],
    ["rejected", "rejected"],
  ] as const)
    assert.equal(
      parseProjectSourceUploadResponse(
        { disposition, upload: upload(phase) },
        expected,
      ).disposition,
      disposition,
    );
  for (const [disposition, phase] of [
    ["committed", "ready"],
    ["pending", "raw-sealed"],
    ["ready", "preparing"],
    ["rejected", "ready"],
  ] as const)
    invalid(() =>
      parseProjectSourceUploadResponse(
        { disposition, upload: upload(phase) },
        expected,
      ),
    );
  invalid(() =>
    parseProjectSourceUploadResponse(
      { disposition: "ready", upload: upload("ready", { uploadId: "other" }) },
      expected,
    ),
  );
});

test("cancel commits advance CAS once while terminal replay can ignore stale revision", () => {
  const expected = request("cancel", {
    uploadId: "upload-1",
    expectedRevision: 1,
  });
  assert.equal(
    parseProjectSourceUploadResponse(
      { disposition: "committed", upload: upload("cancelled") },
      expected,
    ).upload.revision,
    2,
  );
  invalid(() =>
    parseProjectSourceUploadResponse(
      {
        disposition: "committed",
        upload: upload("cancelled", { revision: 3 }),
      },
      expected,
    ),
  );
  invalid(() =>
    parseProjectSourceUploadResponse(
      { disposition: "replayed", upload: upload("ready") },
      expected,
    ),
  );
  const stale = request("cancel", {
    uploadId: "upload-1",
    expectedRevision: 99,
  });
  assert.equal(
    parseProjectSourceUploadResponse(
      { disposition: "replayed", upload: upload("cancelled") },
      stale,
    ).upload.revision,
    2,
  );
});

test("budgets reject oversized commands and responses without expanding old JSON limits", () => {
  invalid(() =>
    parseProjectSourceUploadRequest({
      action: actions.begin,
      input: {
        ...beginInput,
        raw: "x".repeat(MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES),
      },
    }),
  );
  invalid(() =>
    parseProjectSourceUploadResponse(
      {
        upload: {
          ...upload(),
          text: "x".repeat(MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES),
        },
      },
      request("status", { uploadId: "upload-1" }),
    ),
  );
  const byteLength = PROJECT_SOURCE_UPLOAD_MAX_BYTES;
  const partCount = Math.ceil(byteLength / PROJECT_SOURCE_UPLOAD_PART_BYTES);
  const receivedParts = Array.from({ length: partCount }, (_, index) => ({
    index,
    byteLength: Math.min(
      PROJECT_SOURCE_UPLOAD_PART_BYTES,
      byteLength - index * PROJECT_SOURCE_UPLOAD_PART_BYTES,
    ),
    rawDigest: digest,
  }));
  const maximum = upload("raw-sealed", {
    byteLength,
    partCount,
    receivedParts,
    revision: partCount + 2,
  });
  const response = { upload: maximum };
  assert.ok(
    new TextEncoder().encode(JSON.stringify(response)).length <
      MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
  );
  const parsed = parseProjectSourceUploadResponse(
    response,
    request("status", { uploadId: "upload-1" }),
  );
  assert.equal(parsed.upload.receivedParts.length, 306);
  assert.equal(parsed.upload.receivedParts[305]!.byteLength, 11_520);
});

test("raw locator is separate from JSON commands and bounded to 306 parts", () => {
  const locator = { uploadId: "upload-1", partIndex: 305, rawDigest: digest };
  assert.deepEqual(parseProjectSourceUploadPartLocator(locator), locator);
  for (const patch of [
    { partIndex: 306 },
    { partIndex: -1 },
    { partIndex: 0.5 },
    { rawDigest: "bad" },
    { bytes: "AA==" },
    { byteOffset: 0 },
    { expectedRevision: 1 },
  ])
    invalid(() =>
      parseProjectSourceUploadPartLocator({ ...locator, ...patch }),
    );
});

test("canonical part paths round-trip encoded opaque identifiers and lowercase digest", () => {
  const locator = { uploadId: "原文 /1", partIndex: 0, rawDigest: digest };
  const path = projectSourceUploadPartPath("mount 空间", locator);
  assert.match(path, /^\/api\/v1\/plugins\/ui\/mounts\/mount%20/u);
  assert.deepEqual(parseProjectSourceUploadPartPath(path), {
    mountRef: "mount 空间",
    locator,
  });
  assert.equal(
    Object.isFrozen(parseProjectSourceUploadPartPath(path).locator),
    true,
  );
});

test("part paths reject ambiguous URL, digest, escape and index representations", () => {
  const path = projectSourceUploadPartPath("mount", {
    uploadId: "upload",
    partIndex: 0,
    rawDigest: digest,
  });
  for (const value of [
    "https://host" + path,
    path + "?raw=true",
    path + "#fragment",
    path.replace("/parts/0/", "/parts/00/"),
    path.replace("/parts/0/", "/parts/306/"),
    path.replace("/upload/", "/%75pload/"),
    path.replace("/mount/", "/%6dount/"),
    path.replace("/upload/", "/%zz/"),
    path.replace("/upload/", "/../"),
    path.replace("/upload/", "/a/b/"),
    path.replace("a".repeat(64), "A".repeat(64)),
    path.replace("a".repeat(64), "sha256:" + "a".repeat(64)),
  ])
    invalid(() => parseProjectSourceUploadPartPath(value));
});
