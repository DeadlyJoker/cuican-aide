import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import {
  capturePreparedProjectSource,
  type PreparedProjectSource,
} from "./project-source-preparation-port.ts";

const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const actor = {
  tenantId: "tenant",
  spaceId: "space",
  principalId: "owner",
  actorId: "agent-actor",
};
const content = "第一章\n😀初见\n第二章\n又见";
const fileDigest = digest(content.replaceAll("\n", "\r\n"));
const request = {
  actor,
  uploadId: "uploaded-book",
  fileDigest,
  projectId: null,
};
function prepared(): PreparedProjectSource {
  return {
    uploadId: request.uploadId,
    owner: { tenantId: "tenant", spaceId: "space", principalId: "owner" },
    fileName: "故事.txt",
    format: "txt",
    byteLength: Buffer.byteLength(content.replaceAll("\n", "\r\n")),
    characterLength: [...content].length,
    digest: digest(content),
    fileDigest,
    chunks: [
      {
        index: 0,
        startOffset: 0,
        content: "第一章\n😀初见\n",
        digest: digest("第一章\n😀初见\n"),
      },
      {
        index: 1,
        startOffset: 8,
        content: "第二章\n又见",
        digest: digest("第二章\n又见"),
      },
    ],
    chapters: [
      { chapterId: "chapter-1", title: "第一章", startOffset: 0, endOffset: 8 },
      {
        chapterId: "chapter-2",
        title: "第二章",
        startOffset: 8,
        endOffset: 14,
      },
    ],
  };
}
const provenance = () => ({
  version: "crewon.project-source-upload-prepared.v1" as const,
  storageRealmId: "original-host-db",
  uploadId: request.uploadId,
  uploadDigest: digest("actual-raw-ledger"),
  preparedDigest: digest("actual-prepared-manifest"),
  normalizationParserVersion: "source-parser-v1",
});
const capture = (input: unknown) =>
  capturePreparedProjectSource(input, request, { sha256: digest });
const invalid =
  (code = "project_source_preparation_invalid") =>
  (error: unknown) =>
    error instanceof ApplicationError && error.code === code;

test("captures actual Unicode chunk offsets and independent original-byte metadata", () => {
  const input = prepared();
  const result = capture(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.chunks[0], input.chunks[0]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.chapters));
  assert.notEqual(result.digest, result.fileDigest);
});

test("internal preparation retains and detaches an optional immutable upload locator without treating it as a ledger grant", () => {
  const input = { ...prepared(), provenance: provenance() },
    result = capture(input);
  assert.deepEqual(result, input);
  assert.notEqual(result.provenance, input.provenance);
  assert.ok(Object.isFrozen(result.provenance));
  input.provenance.storageRealmId = "changed-host";
  assert.equal(result.provenance!.storageRealmId, "original-host-db");
  assert.equal(Object.hasOwn(capture(prepared()), "provenance"), false);
});

test("optional provenance rejects missing bindings, swapped upload IDs, extra fields and accessors without executing them", () => {
  let invoked = 0;
  const pointer = provenance(),
    nested = { ...pointer },
    outer = { ...prepared(), provenance: pointer };
  Object.defineProperty(nested, "preparedDigest", {
    enumerable: true,
    get() {
      invoked++;
      return pointer.preparedDigest;
    },
  });
  Object.defineProperty(outer, "provenance", {
    enumerable: true,
    get() {
      invoked++;
      return pointer;
    },
  });
  for (const value of [
    undefined,
    null,
    { ...pointer, uploadId: "another-upload" },
    { ...pointer, preparedDigest: "sha256:bad" },
    { ...pointer, uploadDigest: "not-a-digest" },
    { ...pointer, version: "crewon.project-source-upload-prepared.v0" },
    { ...pointer, storageRealmId: "" },
    { ...pointer, normalizationParserVersion: "" },
    { ...pointer, projectId: "caller-project" },
    { ...pointer, preparedDigest: undefined },
    nested,
  ])
    assert.throws(() => capture({ ...prepared(), provenance: value }));
  assert.throws(() => capture(outer), invalid());
  assert.equal(invoked, 0);
});

test("owner and upload identity reject before hashing another owner's content", () => {
  let hashes = 0;
  for (const changed of [
    { ...prepared(), owner: { ...prepared().owner, tenantId: "other" } },
    { ...prepared(), owner: { ...prepared().owner, spaceId: "other" } },
    { ...prepared(), owner: { ...prepared().owner, principalId: "other" } },
    { ...prepared(), uploadId: "different-upload" },
  ])
    assert.throws(
      () =>
        capturePreparedProjectSource(changed, request, {
          sha256(value) {
            hashes++;
            return digest(value);
          },
        }),
      invalid("project_source_upload_not_found"),
    );
  assert.equal(hashes, 0);
  assert.throws(
    () => capture({ ...prepared(), fileDigest: digest("other-file") }),
    invalid("project_source_upload_digest_mismatch"),
  );
});

test("rejects fabricated chunk, full-text digest, Unicode offsets and chapter ranges", () => {
  const input = prepared();
  for (const changed of [
    { ...input, digest: digest("changed") },
    { ...input, characterLength: 15 },
    {
      ...input,
      chunks: [
        { ...input.chunks[0]!, digest: digest("changed") },
        input.chunks[1]!,
      ],
    },
    {
      ...input,
      chunks: [input.chunks[0]!, { ...input.chunks[1]!, startOffset: 9 }],
    },
    {
      ...input,
      chapters: [input.chapters[0]!, { ...input.chapters[1]!, startOffset: 7 }],
    },
    { ...input, chapters: [{ ...input.chapters[0]!, endOffset: 15 }] },
    {
      ...input,
      chapters: [
        input.chapters[0]!,
        { ...input.chapters[1]!, chapterId: "chapter-1" },
      ],
    },
    { ...input, chunks: [] },
    { ...input, byteLength: 20_000_001 },
    { ...input, fileName: "story.html" },
  ])
    assert.throws(() => capture(changed), invalid());
});

test("rejects accessors, sparse or decorated arrays and unrequested authority fields", () => {
  let calls = 0;
  const input = prepared();
  const getter = { ...input };
  Object.defineProperty(getter, "chunks", {
    enumerable: true,
    get() {
      calls++;
      return input.chunks;
    },
  });
  const sparse = new Array(2);
  sparse[1] = input.chunks[1];
  const decorated = Object.assign([...input.chunks], { authority: true });
  const item = { ...input.chunks[0] };
  Object.defineProperty(item, "content", {
    enumerable: true,
    get() {
      calls++;
      return "changed";
    },
  });
  for (const changed of [
    getter,
    { ...input, chunks: sparse },
    { ...input, chunks: decorated },
    { ...input, chunks: [item, input.chunks[1]] },
    { ...input, authority: "caller-grant" },
    { ...input, owner: { ...input.owner, projectId: "caller-project" } },
  ])
    assert.throws(() => capture(changed), invalid());
  assert.equal(calls, 0);
});
