import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSourceUploadActive,
  captureSourceUploadAuthority,
  captureSourceUploadClaim,
  captureSourceUploadInitial,
  captureSourceUploadPart,
  captureSourceUploadPermission,
  captureSourceUploadPrepared,
  captureSourceUploadState,
} from "./project-source-upload-validation.ts";
import { ApplicationError } from "./application-error.ts";
import {
  beginAndWrite,
  sourceUploadFixture,
  uploadActor,
  uploadSha,
} from "./project-source-upload.test-support.ts";
const invalid = (e: unknown) =>
  e instanceof ApplicationError &&
  e.code === "project_source_upload_record_invalid";
function initial() {
  return {
    schemaVersion: "crewon.project-source-upload.v1" as const,
    storageRealmId: "realm",
    uploadId: "upload",
    owner: { tenantId: "tenant", spaceId: "space", principalId: "principal" },
    fileName: "原文.txt",
    format: "txt" as const,
    byteLength: 65_537,
    fileDigest: uploadSha("raw"),
    partBytes: 65_536 as const,
    partCount: 2,
    requestDigest: uploadSha("begin"),
    createdByActorId: "ui",
    createdAt: "2026-10-08T00:00:00.000Z",
  };
}

test("initial and raw descriptors enforce exact byte placement/format and immutable capture", () => {
  const value = initial(),
    captured = captureSourceUploadInitial(value);
  assert.notEqual(captured.owner, value.owner);
  assert.ok(Object.isFrozen(captured.owner));
  assert.deepEqual(
    captureSourceUploadPart(
      {
        index: 1,
        byteOffset: 65_536,
        byteLength: 1,
        rawDigest: uploadSha("x"),
      },
      captured,
    ),
    { index: 1, byteOffset: 65_536, byteLength: 1, rawDigest: uploadSha("x") },
  );
  for (const bad of [
    { ...value, partBytes: 65_537 },
    { ...value, partCount: 1 },
    { ...value, byteLength: 20_000_001 },
    { ...value, fileName: "../book.txt" },
    { ...value, fileName: "book.html" },
    { ...value, consumed: true },
  ])
    assert.throws(() => captureSourceUploadInitial(bad));
  for (const bad of [
    { index: 1, byteOffset: 65_535, byteLength: 1, rawDigest: uploadSha("x") },
    { index: 1, byteOffset: 65_536, byteLength: 2, rawDigest: uploadSha("x") },
    { index: 2, byteOffset: 131_072, byteLength: 1, rawDigest: uploadSha("x") },
  ])
    assert.throws(() => captureSourceUploadPart(bad, captured), invalid);
});

test("descriptor capture refuses accessors and decorated arrays without executing them", () => {
  let executed = 0;
  const value = { ...initial() };
  Object.defineProperty(value, "fileName", {
    enumerable: true,
    get() {
      executed++;
      return "raw.txt";
    },
  });
  assert.throws(() => captureSourceUploadInitial(value), invalid);
  assert.equal(executed, 0);
  const state = {
    initial: initial(),
    revision: 1,
    phase: "receiving",
    updatedAt: initial().createdAt,
    parts: [],
    sealed: null,
    claim: null,
    prepared: null,
    failureCode: null,
  };
  assert.throws(
    () =>
      captureSourceUploadState({
        ...state,
        parts: Object.assign([], { proof: "caller" }),
      }),
    invalid,
  );
  assert.throws(
    () => captureSourceUploadState({ ...state, prepared: { pointer: "fake" } }),
    invalid,
  );
});

test("state phases cannot carry fabricated confirmation, raw pointer or wrong scope", async () => {
  const f = sourceUploadFixture(),
    { state } = await beginAndWrite(f);
  const ready = (
    await f.service.prepare(uploadActor, {
      uploadId: state.initial.uploadId,
      expectedRevision: state.revision,
    })
  ).state;
  assert.ok(Object.isFrozen(captureSourceUploadState(ready).prepared!.pointer));
  for (const changed of [
    { ...ready, phase: "receiving" },
    { ...ready, claim: null },
    { ...ready, sealed: null },
    { ...ready, revision: 1 },
    { ...ready, prepared: { ...ready.prepared!, normalizedByteLength: 1 } },
    {
      ...ready,
      prepared: {
        ...ready.prepared!,
        pointer: { ...ready.prepared!.pointer, storageRealmId: "foreign" },
      },
    },
    {
      ...ready,
      prepared: {
        ...ready.prepared!,
        pointer: {
          ...ready.prepared!.pointer,
          uploadDigest: uploadSha("forged"),
        },
      },
    },
    {
      ...ready,
      prepared: {
        ...ready.prepared!,
        pointer: {
          ...ready.prepared!.pointer,
          normalizationParserVersion: "unrecorded-parser",
        },
      },
    },
    { ...ready, failureCode: "error-in-ready" },
  ])
    assert.throws(() => captureSourceUploadState(changed), invalid);
  assert.throws(() =>
    captureSourceUploadClaim({
      claimId: "c",
      normalizationParserVersion: "v",
      expiresAt: "2026-10-08T00:00:00Z",
    }),
  );
});

test("authority separates every PDP purpose and never executes arbitrary thenables", () => {
  const owner = {
    tenantId: uploadActor.tenantId,
    spaceId: uploadActor.spaceId,
    principalId: uploadActor.principalId,
  };
  const permission = captureSourceUploadPermission({
    actor: uploadActor,
    action: "projectSourceUpload:prepare",
    resource: {
      kind: "projectSourceUpload",
      owner,
      uploadId: "u",
      projectId: null,
    },
  });
  assert.throws(
    () =>
      captureSourceUploadPermission({
        ...permission,
        resource: {
          ...permission.resource,
          owner: { ...owner, principalId: "other" },
        },
      }),
    invalid,
  );
  assert.throws(
    () =>
      captureSourceUploadPermission({
        ...permission,
        action: "projectSourceUpload:begin",
      }),
    invalid,
  );
  assert.throws(
    () =>
      captureSourceUploadPermission({
        ...permission,
        resource: { ...permission.resource, projectId: "not-adoption" },
      }),
    invalid,
  );
  let thenCalls = 0;
  const authority = captureSourceUploadAuthority({
    version: "crewon.project-source-upload-commit.v1",
    permission,
    assertCurrent: async () => {},
    assertActive: () => ({
      then() {
        thenCalls++;
      },
    }),
  });
  assert.throws(() => assertSourceUploadActive(authority), invalid);
  assert.equal(thenCalls, 0);
  const asynchronous = captureSourceUploadAuthority({
    ...authority,
    assertActive: () => Promise.reject(new Error("not synchronous")),
  });
  assert.throws(() => assertSourceUploadActive(asynchronous), invalid);
});

test("prepared capture retains ledger provenance and rejects accessor-backed or swapped upload identities", async () => {
  const f = sourceUploadFixture(),
    { state, command } = await beginAndWrite(f);
  await f.service.prepare(uploadActor, {
    uploadId: state.initial.uploadId,
    expectedRevision: state.revision,
  });
  const input = f.store.prepared.get(state.initial.uploadId)!,
    request = {
      actor: uploadActor,
      uploadId: state.initial.uploadId,
      fileDigest: command.fileDigest,
      projectId: null,
    };
  const result = captureSourceUploadPrepared(input, request, {
    sha256: uploadSha,
  });
  assert.deepEqual(result.provenance, input.provenance);
  assert.notEqual(result.provenance, input.provenance);
  assert.throws(
    () =>
      captureSourceUploadPrepared(
        { ...input, provenance: { ...input.provenance, uploadId: "another" } },
        request,
        { sha256: uploadSha },
      ),
    invalid,
  );
  let called = 0;
  const accessor = { ...input };
  Object.defineProperty(accessor, "provenance", {
    enumerable: true,
    get() {
      called++;
      return input.provenance;
    },
  });
  assert.throws(
    () => captureSourceUploadPrepared(accessor, request, { sha256: uploadSha }),
    invalid,
  );
  assert.equal(called, 0);
});
