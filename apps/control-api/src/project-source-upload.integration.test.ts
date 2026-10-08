import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApplicationError,
  type ProjectSourceUploadApplicationService,
  type ProjectSourceUploadState,
} from "@crewon/application";
import { parseProjectSourceFile } from "@crewon/media-runtime";
import {
  sourceUploadFixture,
  uploadActor,
  uploadAgent,
  uploadForeign,
  uploadHash,
  uploadOwner,
  uploadTime,
  type UploadBackend,
} from "./project-source-upload.test-support.ts";

const fixedPart = 65_536;
function failure(code: string) {
  return (error: unknown) =>
    error instanceof Error && error.message.includes(code);
}
async function receive(
  service: ProjectSourceUploadApplicationService,
  bytes: Uint8Array,
  key: string,
  format: "txt" | "md" | "html" = "txt",
) {
  const initial = await service.begin(uploadActor, {
    idempotencyKey: key,
    fileName: `story.${format}`,
    format,
    byteLength: bytes.byteLength,
    fileDigest: uploadHash(bytes),
  });
  let state = initial.state;
  for (let index = 0; index < state.initial.partCount; index++) {
    const body = bytes.slice(
      index * fixedPart,
      Math.min(bytes.byteLength, (index + 1) * fixedPart),
    );
    state = (
      await service.writePart(uploadActor, {
        uploadId: state.initial.uploadId,
        expectedRevision: state.revision,
        index,
        byteOffset: index * fixedPart,
        rawDigest: uploadHash(body),
        bytes: body,
      })
    ).state;
  }
  return state;
}
for (const backend of ["sqlite", "postgres"] as const) {
  const skip =
    backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL
      ? "isolated real PostgreSQL required"
      : false;
  test(
    `${backend}: immutable owned multipart journal reopens and uses the actual parser, chapters and multiuse prepared proof`,
    { skip, timeout: 120_000 },
    async (t) => {
      const f = await sourceUploadFixture(t, backend);
      let h = await f.open();
      const realm = h.uploads.storageRealmId;
      const bytes = new TextEncoder().encode(
        "第一章 雨夜\r\n" +
          "é😀雨".repeat(15_000) +
          "\r\n第二章 来信\r\n结束。",
      );
      const begin = await h.service.begin(uploadActor, {
        idempotencyKey: "cold-file",
        fileName: "story.txt",
        format: "txt",
        byteLength: bytes.byteLength,
        fileDigest: uploadHash(bytes),
      });
      let state = begin.state;
      const first = bytes.slice(0, fixedPart),
        command = {
          uploadId: state.initial.uploadId,
          expectedRevision: state.revision,
          index: 0,
          byteOffset: 0,
          rawDigest: uploadHash(first),
          bytes: first,
        };
      state = (await h.service.writePart(uploadActor, command)).state;
      assert.equal(
        (await h.service.writePart(uploadActor, command)).disposition,
        "replayed",
      );
      const changed = first.slice();
      changed[0] ^= 1;
      await assert.rejects(
        h.service.writePart(uploadActor, {
          ...command,
          bytes: changed,
          rawDigest: uploadHash(changed),
        }),
        failure("part_conflict"),
      );
      await f.close();
      h = await f.open();
      assert.equal(h.uploads.storageRealmId, realm);
      assert.deepEqual(
        await h.service.getStatus(uploadAgent, {
          uploadId: state.initial.uploadId,
        }),
        state,
      );
      await assert.rejects(
        h.service.getStatus(uploadForeign, {
          uploadId: state.initial.uploadId,
        }),
        failure("not_found"),
      );
      const count = f.state.idCalls;
      assert.equal(
        (
          await h.service.begin(uploadAgent, {
            idempotencyKey: "cold-file",
            fileName: "story.txt",
            format: "txt",
            byteLength: bytes.byteLength,
            fileDigest: uploadHash(bytes),
          })
        ).state.initial.uploadId,
        state.initial.uploadId,
      );
      assert.equal(f.state.idCalls, count);
      for (let index = 1; index < state.initial.partCount; index++) {
        const body = bytes.slice(index * fixedPart, (index + 1) * fixedPart);
        state = (
          await h.service.writePart(uploadAgent, {
            uploadId: state.initial.uploadId,
            expectedRevision: state.revision,
            index,
            byteOffset: index * fixedPart,
            rawDigest: uploadHash(body),
            bytes: body,
          })
        ).state;
      }
      const ready = await h.service.prepare(uploadAgent, {
        uploadId: state.initial.uploadId,
        expectedRevision: state.revision,
      });
      assert.equal(ready.disposition, "ready");
      assert.equal(f.state.parserCalls, 1);
      const reference = {
        uploadId: state.initial.uploadId,
        fileDigest: uploadHash(bytes),
        projectId: null,
      };
      const prepared = await h.service.getPreparedForAdoption(
        uploadAgent,
        reference,
      );
      assert.ok(prepared);
      assert.equal(prepared.chapters.length, 2);
      assert.equal(prepared.provenance.storageRealmId, realm);
      const actual = parseProjectSourceFile({
        fileName: "story.txt",
        format: "txt",
        bytes,
      });
      assert.equal(prepared.digest, actual.digest);
      assert.equal(prepared.fileDigest, actual.fileDigest);
      assert.deepEqual(prepared.chunks, actual.chunks);
      await f.close();
      h = await f.open();
      assert.deepEqual(
        await h.service.getPreparedForAdoption(uploadActor, reference),
        prepared,
      );
      assert.deepEqual(
        await h.service.getPreparedForAdoption(uploadAgent, reference),
        prepared,
      );
      assert.equal(
        (
          await h.service.prepare(uploadActor, {
            uploadId: state.initial.uploadId,
            expectedRevision: 1,
          })
        ).disposition,
        "ready",
      );
      assert.equal(f.state.parserCalls, 1);
      const rows = await f.query(
        "SELECT count(*) AS total FROM $schema.creative_projects",
      );
      assert.equal(
        Number(rows[0]!.total),
        0,
        "uploading and preparing never create a project",
      );
    },
  );
  test(
    `${backend}: part CAS, missing chunks, digest errors, exact sizes and cancellation preserve durable facts`,
    { skip, timeout: 30_000 },
    async (t) => {
      const f = await sourceUploadFixture(t, backend),
        h = await f.open(),
        bytes = new TextEncoder().encode("雨".repeat(50_000));
      const begun = await h.service.begin(uploadActor, {
          idempotencyKey: "cas",
          fileName: "novel.txt",
          format: "txt",
          byteLength: bytes.length,
          fileDigest: uploadHash(bytes),
        }),
        state = begun.state;
      await assert.rejects(
        h.service.prepare(uploadActor, {
          uploadId: state.initial.uploadId,
          expectedRevision: state.revision,
        }),
        failure("parts_incomplete"),
      );
      const part = (index: number) => {
        const body = bytes.slice(index * fixedPart, (index + 1) * fixedPart);
        return {
          uploadId: state.initial.uploadId,
          expectedRevision: state.revision,
          index,
          byteOffset: index * fixedPart,
          rawDigest: uploadHash(body),
          bytes: body,
        };
      };
      const competing = await Promise.allSettled([
        h.service.writePart(uploadActor, part(0)),
        h.service.writePart(uploadAgent, part(1)),
      ]);
      assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(competing.filter((r) => r.status === "rejected").length, 1);
      const current = await h.service.getStatus(uploadActor, {
        uploadId: state.initial.uploadId,
      });
      assert.equal(current.revision, 2);
      assert.equal(current.parts.length, 1);
      const missing = current.parts[0]!.index === 0 ? 1 : 0;
      await assert.rejects(
        h.service.writePart(uploadActor, {
          ...part(missing),
          expectedRevision: 2,
          rawDigest: uploadHash("wrong"),
        }),
        failure("digest_mismatch"),
      );
      await assert.rejects(
        h.service.writePart(uploadActor, {
          ...part(missing),
          expectedRevision: 2,
          bytes: new Uint8Array(fixedPart + 1),
        }),
      );
      assert.deepEqual(
        await h.service.getStatus(uploadActor, {
          uploadId: state.initial.uploadId,
        }),
        current,
      );
      const cancelled = await h.service.cancel(uploadActor, {
        uploadId: state.initial.uploadId,
        expectedRevision: 2,
      });
      assert.equal(cancelled.state.phase, "cancelled");
      assert.equal(
        (
          await h.service.cancel(uploadAgent, {
            uploadId: state.initial.uploadId,
            expectedRevision: 1,
          })
        ).disposition,
        "replayed",
      );
      await assert.rejects(
        h.service.writePart(uploadActor, {
          ...part(missing),
          expectedRevision: cancelled.state.revision,
        }),
        failure("state_conflict"),
      );
      await assert.rejects(
        h.service.begin(uploadActor, {
          idempotencyKey: "cas",
          fileName: "other.txt",
          format: "txt",
          byteLength: bytes.length,
          fileDigest: uploadHash(bytes),
        }),
        failure("idempotency_conflict"),
      );
    },
  );
  test(
    `${backend}: real HTML/MD/UTF16 decode, invalid byte rejection and actual whole-file digest verification`,
    { skip, timeout: 45_000 },
    async (t) => {
      const f = await sourceUploadFixture(t, backend),
        h = await f.open();
      const examples = [
        {
          format: "md" as const,
          bytes: new TextEncoder().encode(
            "# 第一章 雨夜\n你好😀\n# 第二章 来信\n结尾",
          ),
        },
        {
          format: "html" as const,
          bytes: new TextEncoder().encode(
            "<script>隐藏</script><main><h1>第一章 来信</h1><p>雨夜 &amp; 😀</p></main>",
          ),
        },
        {
          format: "txt" as const,
          bytes: new Uint8Array(
            Buffer.concat([
              Buffer.from([0xff, 0xfe]),
              Buffer.from("第一章 来信\r\n雨夜😀", "utf16le"),
            ]),
          ),
        },
      ];
      for (let index = 0; index < examples.length; index++) {
        const sample = examples[index]!,
          state = await receive(
            h.service,
            sample.bytes,
            `format-${index}`,
            sample.format,
          ),
          ready = await h.service.prepare(uploadActor, {
            uploadId: state.initial.uploadId,
            expectedRevision: state.revision,
          });
        assert.equal(ready.disposition, "ready");
        const prepared = await h.service.getPreparedForAdoption(uploadActor, {
          uploadId: state.initial.uploadId,
          fileDigest: uploadHash(sample.bytes),
          projectId: null,
        });
        assert.ok(prepared);
        assert.equal(
          prepared.digest,
          parseProjectSourceFile({
            fileName: `story.${sample.format}`,
            format: sample.format,
            bytes: sample.bytes,
          }).digest,
        );
      }
      const malformed = new Uint8Array([0xff, 0xfe, 0x61]),
        bad = await receive(h.service, malformed, "malformed"),
        rejected = await h.service.prepare(uploadActor, {
          uploadId: bad.initial.uploadId,
          expectedRevision: bad.revision,
        });
      assert.equal(rejected.disposition, "rejected");
      assert.equal(
        rejected.state.failureCode,
        "project_source_import_encoding_invalid",
      );
      const bytes = new TextEncoder().encode("故事"),
        lie = await h.service.begin(uploadActor, {
          idempotencyKey: "lying-digest",
          fileName: "story.txt",
          format: "txt",
          byteLength: bytes.length,
          fileDigest: uploadHash("not story"),
        });
      const written = await h.service.writePart(uploadActor, {
        uploadId: lie.state.initial.uploadId,
        expectedRevision: 1,
        index: 0,
        byteOffset: 0,
        bytes,
        rawDigest: uploadHash(bytes),
      });
      await assert.rejects(
        h.service.prepare(uploadActor, {
          uploadId: written.state.initial.uploadId,
          expectedRevision: 2,
        }),
        failure("file_digest_mismatch"),
      );
      assert.equal(
        (
          await h.service.getStatus(uploadActor, {
            uploadId: written.state.initial.uploadId,
          })
        ).phase,
        "receiving",
      );
    },
  );
  test(
    `${backend}: interrupted parse claim is recoverable, stale claim cannot write, identical completion replays`,
    { skip, timeout: 30_000 },
    async (t) => {
      const f = await sourceUploadFixture(t, backend),
        h = await f.open(),
        bytes = new TextEncoder().encode("第一章 原文\n雨夜😀"),
        received = await receive(h.service, bytes, "claims"),
        id = received.initial.uploadId,
        authority = f.grant("projectSourceUpload:prepare", id);
      const sealed = await h.uploads.sealRaw(
          {
            actor: uploadActor,
            uploadId: id,
            expectedRevision: received.revision,
            at: uploadTime,
          },
          authority,
        ),
        first = await h.uploads.claimPreparation(
          {
            actor: uploadActor,
            uploadId: id,
            expectedRevision: sealed.state.revision,
            at: uploadTime,
            claim: {
              claimId: "claim-a",
              normalizationParserVersion: "parser-a",
              expiresAt: "2026-10-08T00:00:01.000Z",
            },
          },
          authority,
        );
      assert.equal(first.disposition, "claimed");
      await f.close();
      const reopened = await f.open();
      const second = await reopened.uploads.claimPreparation(
        {
          actor: uploadActor,
          uploadId: id,
          expectedRevision: first.state.revision,
          at: "2026-10-08T00:00:02.000Z",
          claim: {
            claimId: "claim-b",
            normalizationParserVersion: "parser-b",
            expiresAt: "2026-10-08T00:01:00.000Z",
          },
        },
        authority,
      );
      assert.equal(second.disposition, "claimed");
      await assert.rejects(
        reopened.uploads.loadRawBytes(
          {
            owner: uploadOwner,
            uploadId: id,
            uploadDigest: sealed.state.sealed!.uploadDigest,
            claimId: "claim-a",
          },
          authority,
        ),
        failure("claim_conflict"),
      );
      assert.deepEqual(
        await reopened.uploads.loadRawBytes(
          {
            owner: uploadOwner,
            uploadId: id,
            uploadDigest: sealed.state.sealed!.uploadDigest,
            claimId: "claim-b",
          },
          authority,
        ),
        bytes,
      );
      const parsed = parseProjectSourceFile({
          fileName: "story.txt",
          format: "txt",
          bytes,
        }),
        complete = {
          actor: uploadActor,
          uploadId: id,
          expectedRevision: second.state.revision,
          claimId: "claim-b",
          at: "2026-10-08T00:00:03.000Z",
          parsed,
        };
      const result = await reopened.uploads.completePreparation(
        complete,
        authority,
      );
      assert.equal(result.state.phase, "ready");
      const replay = await reopened.uploads.completePreparation(
        { ...complete, expectedRevision: 1, at: "2026-10-08T00:00:04.000Z" },
        authority,
      );
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.state, result.state);
    },
  );
  test(
    `${backend}: synchronous withdrawal rolls back head/part/event; immutable SQL ledger and identity reject changes`,
    { skip, timeout: 30_000 },
    async (t) => {
      const f = await sourceUploadFixture(t, backend),
        h = await f.open(),
        bytes = new TextEncoder().encode("原文"),
        begun = await h.service.begin(uploadActor, {
          idempotencyKey: "rollback",
          fileName: "story.txt",
          format: "txt",
          byteLength: bytes.length,
          fileDigest: uploadHash(bytes),
        }),
        id = begun.state.initial.uploadId;
      let activeChecks = 0;
      const authority = f.grant("projectSourceUpload:write", id),
        bad = {
          ...authority,
          assertActive() {
            activeChecks++;
            if (activeChecks === 2)
              throw new ApplicationError("authorization", "request-withdrawn");
          },
        };
      await assert.rejects(
        h.uploads.writePart(
          {
            actor: uploadActor,
            uploadId: id,
            expectedRevision: 1,
            at: uploadTime,
            part: {
              index: 0,
              byteOffset: 0,
              byteLength: bytes.length,
              rawDigest: uploadHash(bytes),
            },
            bytes,
          },
          bad,
        ),
      );
      assert.equal(
        activeChecks,
        2,
        "withdrawal happens after SQL writes and before COMMIT",
      );
      assert.deepEqual(
        await h.service.getStatus(uploadActor, { uploadId: id }),
        begun.state,
      );
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS total FROM $schema.project_source_upload_parts",
            )
          )[0]!.total,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS total FROM $schema.project_source_upload_events",
            )
          )[0]!.total,
        ),
        1,
      );
      await assert.rejects(
        f.execute(
          "UPDATE $schema.project_source_uploads SET file_digest=$1 WHERE upload_id=$2",
          [uploadHash("tampered"), id],
        ),
        failure("immutable"),
      );
      await assert.rejects(
        f.execute(
          "DELETE FROM $schema.project_source_upload_events WHERE upload_id=$1",
          [id],
        ),
        failure("immutable"),
      );
      await assert.rejects(
        f.execute(
          "UPDATE $schema.project_source_upload_heads SET owner_principal_id=$1 WHERE upload_id=$2",
          ["foreign", id],
        ),
        failure("immutable"),
      );
    },
  );
  test(
    `${backend}: confirmed SQL COMMIT is returned accurately when request authority withdraws immediately afterwards`,
    { skip, timeout: 30_000 },
    async (t) => {
      const f = await sourceUploadFixture(t, backend),
        h = await f.open(),
        bytes = new TextEncoder().encode("原文"),
        begun = await h.service.begin(uploadActor, {
          idempotencyKey: "commit-fact",
          fileName: "story.txt",
          format: "txt",
          byteLength: bytes.length,
          fileDigest: uploadHash(bytes),
        }),
        id = begun.state.initial.uploadId;
      f.state.afterCommit = true;
      const result = await h.uploads.writePart(
        {
          actor: uploadActor,
          uploadId: id,
          expectedRevision: 1,
          at: uploadTime,
          part: {
            index: 0,
            byteOffset: 0,
            byteLength: bytes.length,
            rawDigest: uploadHash(bytes),
          },
          bytes,
        },
        f.grant("projectSourceUpload:write", id),
      );
      assert.equal(
        f.state.active,
        false,
        "authority withdrawn after actual original SQL COMMIT",
      );
      assert.equal(result.disposition, "committed");
      assert.equal(result.state.revision, 2);
      f.state.afterCommit = false;
      f.state.active = true;
      await f.close();
      const reopened = await f.open();
      assert.deepEqual(
        await reopened.service.getStatus(uploadActor, { uploadId: id }),
        result.state,
      );
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS total FROM $schema.project_source_upload_parts",
            )
          )[0]!.total,
        ),
        1,
      );
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS total FROM $schema.project_source_upload_events",
            )
          )[0]!.total,
        ),
        2,
      );
    },
  );
  test(
    `${backend}: actual 20,000,000 byte Unicode file survives 306 raw parts, physical reopen and normalized proof`,
    { skip, timeout: 180_000 },
    async (t) => {
      const f = await sourceUploadFixture(t, backend);
      let h = await f.open();
      const bytes = Buffer.from("😀".repeat(5_000_000));
      assert.equal(bytes.length, 20_000_000);
      const received = await receive(h.service, bytes, "twenty-megabyte"),
        ready = await h.service.prepare(uploadActor, {
          uploadId: received.initial.uploadId,
          expectedRevision: received.revision,
        });
      assert.equal(ready.disposition, "ready");
      assert.equal(ready.state.parts.length, 306);
      assert.equal(ready.state.prepared!.normalizedByteLength, 20_000_000);
      assert.equal(ready.state.prepared!.characterLength, 5_000_000);
      await f.close();
      h = await f.open();
      const prepared = await h.service.getPreparedForAdoption(uploadAgent, {
        uploadId: received.initial.uploadId,
        fileDigest: uploadHash(bytes),
        projectId: null,
      });
      assert.ok(prepared);
      assert.equal(
        uploadHash(prepared.chunks.map((c) => c.content).join("")),
        uploadHash(bytes),
      );
      assert.equal(
        prepared.provenance.preparedDigest,
        ready.state.prepared!.pointer.preparedDigest,
      );
      await assert.rejects(
        h.service.begin(uploadActor, {
          idempotencyKey: "over-limit",
          fileName: "story.txt",
          format: "txt",
          byteLength: 20_000_001,
          fileDigest: uploadHash("big"),
        }),
      );
      assert.equal(
        Number(
          (
            await f.query(
              "SELECT count(*) AS total FROM $schema.project_source_uploads",
            )
          )[0]!.total,
        ),
        1,
      );
    },
  );
}
