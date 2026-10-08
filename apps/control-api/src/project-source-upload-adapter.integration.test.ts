import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type {
  ProjectSourceUploadApplicationService,
  ProjectSourceUploadPreparedSource,
  ProjectSourceUploadState,
} from "@crewon/application";
import {
  sourceUploadFixture,
  uploadActor,
  uploadAgent,
  uploadHash,
  uploadOwner,
} from "./project-source-upload.test-support.ts";

const partBytes = 65_536;
async function receive(
  service: ProjectSourceUploadApplicationService,
  bytes: Uint8Array,
  idempotencyKey: string,
) {
  let state = (
    await service.begin(uploadActor, {
      idempotencyKey,
      fileName: "story.txt",
      format: "txt",
      byteLength: bytes.byteLength,
      fileDigest: uploadHash(bytes),
    })
  ).state;
  for (let index = 0; index < state.initial.partCount; index++) {
    const body = bytes.slice(index * partBytes, (index + 1) * partBytes);
    state = (
      await service.writePart(uploadActor, {
        uploadId: state.initial.uploadId,
        expectedRevision: state.revision,
        index,
        byteOffset: index * partBytes,
        rawDigest: uploadHash(body),
        bytes: body,
      })
    ).state;
  }
  return state;
}
function canonical(value: unknown): string {
  function ordered(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === "object")
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [
            key,
            ordered((input as Record<string, unknown>)[key]),
          ]),
      );
    return input;
  }
  return JSON.stringify(ordered(value));
}
function manifestDigest(domain: string, rows: readonly unknown[]): string {
  const hash = createHash("sha256").update(`${domain}\n`);
  for (const row of rows) hash.update(canonical(row)).update("\n");
  return `sha256:${hash.digest("hex")}`;
}
/** Independently recompute every bound root, including the original byte manifest. */
function assertPreparedRoots(
  state: ProjectSourceUploadState,
  source: ProjectSourceUploadPreparedSource,
) {
  assert.equal(state.phase, "ready");
  assert.ok(state.sealed && state.claim && state.prepared);
  const manifest = state.prepared,
    text = source.chunks.map((chunk) => chunk.content).join("");
  assert.equal(
    state.sealed.uploadDigest,
    manifestDigest("crewon.project-source-upload.raw-manifest.v1", [
      state.initial,
      ...state.parts,
    ]),
  );
  assert.equal(manifest.digest, uploadHash(text));
  assert.equal(manifest.normalizedByteLength, Buffer.byteLength(text));
  assert.equal(manifest.characterLength, [...text].length);
  assert.equal(manifest.chunkCount, source.chunks.length);
  assert.equal(manifest.chapterCount, source.chapters.length);
  assert.equal(
    manifest.chunkManifestDigest,
    manifestDigest(
      "crewon.project-source-upload.chunks.v1",
      source.chunks.map((chunk) => {
        assert.equal(chunk.digest, uploadHash(chunk.content));
        return {
          index: chunk.index,
          startOffset: chunk.startOffset,
          characterLength: [...chunk.content].length,
          byteLength: Buffer.byteLength(chunk.content),
          digest: chunk.digest,
        };
      }),
    ),
  );
  assert.equal(
    manifest.chapterManifestDigest,
    manifestDigest("crewon.project-source-upload.chapters.v1", source.chapters),
  );
  const { pointer, ...metrics } = manifest;
  assert.equal(
    pointer.preparedDigest,
    uploadHash(
      "crewon.project-source-upload.prepared-manifest.v1\n" +
        canonical({
          version: pointer.version,
          storageRealmId: state.initial.storageRealmId,
          uploadId: state.initial.uploadId,
          uploadDigest: state.sealed.uploadDigest,
          normalizationParserVersion: state.claim.normalizationParserVersion,
          ...metrics,
        }),
    ),
  );
  assert.deepEqual(source.provenance, pointer);
  assert.equal(source.fileDigest, state.initial.fileDigest);
  assert.equal(source.byteLength, state.initial.byteLength);
}
async function assertNoPartialPreparation(
  f: Awaited<ReturnType<typeof sourceUploadFixture>>,
) {
  for (const table of [
    "creative_projects",
    "project_source_upload_prepared",
    "project_source_upload_prepared_chunks",
    "project_source_upload_prepared_chapters",
    "project_source_upload_associations",
  ]) {
    const rows = await f.query(
      `SELECT count(*) AS total FROM $schema.${table}`,
    );
    assert.equal(Number(rows[0]!.total), 0, `${table} must remain empty`);
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  const skip =
    backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL
      ? "isolated real PostgreSQL required"
      : false;
  test(
    `${backend}: actual UTF16 bytes below 20 MB reject UTF8 expansion above 20 MB without partial prepared records`,
    { skip, timeout: 120_000 },
    async (t) => {
      const f = await sourceUploadFixture(t, backend),
        h = await f.open(),
        text = "汉".repeat(6_666_667),
        bytes = new Uint8Array(
          Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from(text, "utf16le"),
          ]),
        );
      assert.equal(bytes.byteLength, 13_333_336);
      assert.equal(Buffer.byteLength(text), 20_000_001);
      const state = await receive(h.service, bytes, "utf16-expanded"),
        rejected = await h.service.prepare(uploadActor, {
          uploadId: state.initial.uploadId,
          expectedRevision: state.revision,
        });
      assert.equal(rejected.disposition, "rejected");
      assert.equal(rejected.state.phase, "rejected");
      assert.equal(
        rejected.state.failureCode,
        "project_source_import_text_limit",
      );
      assert.equal(rejected.state.prepared, null);
      assert.ok(rejected.state.sealed && rejected.state.claim);
      assert.equal(f.state.parserCalls, 1);
      await assertNoPartialPreparation(f);
      await assert.rejects(
        h.service.getPreparedForAdoption(uploadActor, {
          uploadId: state.initial.uploadId,
          fileDigest: uploadHash(bytes),
          projectId: null,
        }),
        /project_source_upload_not_ready/u,
      );
      const idCalls = f.state.idCalls;
      assert.deepEqual(
        await h.service.prepare(uploadAgent, {
          uploadId: state.initial.uploadId,
          expectedRevision: 1,
        }),
        rejected,
      );
      assert.equal(f.state.parserCalls, 1);
      assert.equal(f.state.idCalls, idCalls);
    },
  );
  test(
    `${backend}: unknown infrastructure fault never invokes the parser and an expired durable claim resumes the same upload`,
    { skip, timeout: 30_000 },
    async (t) => {
      const f = await sourceUploadFixture(t, backend);
      let h = await f.open();
      const bytes = new TextEncoder().encode("第一章 雨夜\r\n来信😀"),
        received = await receive(
          h.service,
          bytes,
          "recoverable-infrastructure",
        ),
        uploadId = received.initial.uploadId,
        fault = new Error("source_parser_infrastructure_unavailable");
      f.state.parserFault = fault;
      await assert.rejects(
        h.service.prepare(uploadActor, {
          uploadId,
          expectedRevision: received.revision,
        }),
        (error: unknown) => error === fault,
      );
      const preparing = await h.service.getStatus(uploadActor, { uploadId });
      assert.equal(preparing.phase, "preparing");
      assert.ok(preparing.claim && preparing.sealed);
      assert.equal(preparing.failureCode, null);
      assert.equal(preparing.prepared, null);
      assert.equal(f.state.parserCalls, 0);
      await assertNoPartialPreparation(f);
      await f.close();
      h = await f.open();
      const idCalls = f.state.idCalls,
        pending = await h.service.prepare(uploadAgent, {
          uploadId,
          expectedRevision: preparing.revision,
        });
      assert.equal(pending.disposition, "pending");
      assert.deepEqual(pending.state, preparing);
      assert.equal(f.state.idCalls, idCalls);
      assert.equal(f.state.parserCalls, 0);
      f.state.parserFault = null;
      f.state.now = new Date(
        Date.parse(preparing.claim.expiresAt) + 1,
      ).toISOString();
      const ready = await h.service.prepare(uploadAgent, {
        uploadId,
        expectedRevision: preparing.revision,
      });
      assert.equal(ready.disposition, "ready");
      assert.equal(ready.state.initial.uploadId, uploadId);
      assert.equal(
        ready.state.initial.storageRealmId,
        preparing.initial.storageRealmId,
      );
      assert.equal(
        ready.state.sealed!.uploadDigest,
        preparing.sealed.uploadDigest,
      );
      assert.notEqual(ready.state.claim!.claimId, preparing.claim.claimId);
      assert.equal(
        f.state.idCalls,
        idCalls + 1,
        "only a new claim ID is generated",
      );
      assert.equal(f.state.parserCalls, 1);
      const prepared = await h.service.getPreparedForAdoption(uploadActor, {
        uploadId,
        fileDigest: uploadHash(bytes),
        projectId: null,
      });
      assertPreparedRoots(ready.state, prepared);
      assert.equal(prepared.digest, uploadHash("第一章 雨夜\n来信😀"));
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS total FROM $schema.creative_projects",
            )
          )[0]!.total,
        ),
        0,
      );
    },
  );
  test(
    `${backend}: ready proof survives isolated raw payload deletion and cold reopening with multiple authorized adoption reads`,
    { skip, timeout: 30_000 },
    async (t) => {
      const f = await sourceUploadFixture(t, backend);
      let h = await f.open();
      const bytes = new TextEncoder().encode(
          "第一章 雨夜\r\n" +
            "é😀雨".repeat(12_000) +
            "\r\n第二章 来信\r\n结尾。",
        ),
        received = await receive(h.service, bytes, "ready-canonical"),
        uploadId = received.initial.uploadId,
        ready = await h.service.prepare(uploadActor, {
          uploadId,
          expectedRevision: received.revision,
        });
      assert.equal(ready.disposition, "ready");
      const reference = {
          uploadId,
          fileDigest: uploadHash(bytes),
          projectId: null,
        },
        prepared = await h.service.getPreparedForAdoption(
          uploadActor,
          reference,
        ),
        retained = await f.query(
          "SELECT record_json FROM $schema.project_source_upload_prepared WHERE upload_id=$1",
          [uploadId],
        );
      assertPreparedRoots(ready.state, prepared);
      assert.ok(received.parts.length > 1);
      assert.equal(f.state.parserCalls, 1);
      // Only this disposable fixture simulates a future raw-byte GC step.
      // No GC service, scheduler, project adoption or source association is implemented here.
      await f.execute(
        "DELETE FROM $schema.project_source_upload_part_payloads WHERE upload_id=$1",
        [uploadId],
      );
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS total FROM $schema.project_source_upload_part_payloads",
            )
          )[0]!.total,
        ),
        0,
      );
      assert.deepEqual(
        await h.uploads.loadPrepared(
          { owner: uploadOwner, uploadId, fileDigest: reference.fileDigest },
          f.grant("projectSourceUpload:adopt", uploadId),
        ),
        prepared,
      );
      await f.close();
      h = await f.open();
      f.state.parserFault = new Error("raw_payload_gc_must_not_reparse");
      const idCalls = f.state.idCalls;
      for (const projectId of ["project-alpha", "project-beta", null]) {
        const adopted = await h.service.getPreparedForAdoption(uploadAgent, {
          ...reference,
          projectId,
        });
        assert.deepEqual(adopted, prepared);
        assertPreparedRoots(ready.state, adopted);
      }
      assert.deepEqual(
        await h.service.prepare(uploadActor, { uploadId, expectedRevision: 1 }),
        ready,
      );
      assert.deepEqual(
        await f.query(
          "SELECT record_json FROM $schema.project_source_upload_prepared WHERE upload_id=$1",
          [uploadId],
        ),
        retained,
      );
      assert.equal(f.state.parserCalls, 1);
      assert.equal(f.state.idCalls, idCalls);
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS total FROM $schema.project_source_upload_parts",
            )
          )[0]!.total,
        ),
        received.parts.length,
        "immutable raw descriptors remain after payload deletion",
      );
    },
  );
}
