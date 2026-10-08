import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ProjectFoundationMutationResponse } from "@crewon/contracts/project-foundation";
import {
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  projectSourceUploadPartPath,
} from "@crewon/contracts/project-source-uploads";
import { foundationUiHttpFixture } from "./project-foundation-plugin-ui.integration.test-support.ts";
import { importParameters } from "./project-foundation-import.test-support.ts";
import {
  actor,
  optionsFor,
  selectionRecipe,
} from "../../../packages/store/src/creative-project-plugin-commit.test-support.ts";

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
type Fixture = Awaited<ReturnType<typeof foundationUiHttpFixture>>;
const locator = (uploadId: string, partIndex: number, bytes: Uint8Array) => ({
  uploadId,
  partIndex,
  rawDigest: digest(bytes),
});
async function count(f: Fixture, table: string) {
  return Number(
    (await f.f.query(`SELECT count(*) AS n FROM ${f.f.prefix}${table}`))[0]!.n,
  );
}
async function begin(f: Fixture, bytes: Uint8Array, key = "raw-http-begin") {
  const input = {
    fileName: "雨夜.md",
    format: "md" as const,
    byteLength: bytes.byteLength,
    fileDigest: digest(bytes),
    idempotencyKey: key,
  };
  return { input, result: await f.invokeUpload("begin", input) };
}
async function upload(f: Fixture, bytes: Uint8Array, key = "raw-http-begin") {
  const started = await begin(f, bytes, key);
  let head = started.result.upload;
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += PROJECT_SOURCE_UPLOAD_PART_BYTES
  ) {
    const part = bytes.subarray(
      offset,
      offset + PROJECT_SOURCE_UPLOAD_PART_BYTES,
    );
    head = (
      await f.writePart(
        locator(head.uploadId, offset / PROJECT_SOURCE_UPLOAD_PART_BYTES, part),
        part,
      )
    ).upload;
  }
  const prepared = await f.invokeUpload("prepare", {
    uploadId: head.uploadId,
    expectedRevision: head.revision,
  });
  assert.equal(prepared.upload.phase, "ready");
  return { ...started, prepared };
}
const novel = (uploadId: string, fileDigest: string, key: string) => ({
  title: "雨夜小说改编",
  briefText: "保留两章主线，先确认改编方案。",
  origin: "novel" as const,
  parameters: importParameters("novel"),
  creativeStartMode: null,
  sourceUpload: { uploadId, fileDigest },
  idempotencyKey: key,
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: formal mounted JSON/raw upload prepares actual source and adopts it into two independent novel projects`,
    optionsFor(backend),
    async (t) => {
      const f = await foundationUiHttpFixture(t, backend, { uploads: true });
      const text = `# 第一章 雨夜\n${"雨😀夜。".repeat(6500)}\n# 第二章 寻人\n两人在雨夜重逢。`;
      const bytes = Buffer.from(text, "utf8");
      assert.ok(bytes.byteLength > PROJECT_SOURCE_UPLOAD_PART_BYTES);
      const started = await begin(f, bytes),
        id = started.result.upload.uploadId;
      assert.equal(started.result.upload.phase, "receiving");
      const first = bytes.subarray(0, PROJECT_SOURCE_UPLOAD_PART_BYTES),
        firstLocator = locator(id, 0, first);
      const written = await f.writePart(firstLocator, first);
      assert.equal(written.disposition, "committed");
      const replay = await f.writePart(firstLocator, first);
      assert.deepEqual(replay, { ...written, disposition: "replayed" });
      const tail = bytes.subarray(PROJECT_SOURCE_UPLOAD_PART_BYTES);
      const complete = await f.writePart(locator(id, 1, tail), tail);
      assert.equal(complete.upload.receivedParts.length, 2);
      const prepared = await f.invokeUpload("prepare", {
        uploadId: id,
        expectedRevision: complete.upload.revision,
      });
      assert.equal(prepared.upload.phase, "ready");
      assert.equal(prepared.upload.prepared!.digest, digest(bytes));
      assert.equal(
        prepared.upload.prepared!.normalizedByteLength,
        bytes.byteLength,
      );
      assert.equal(
        prepared.upload.prepared!.characterLength,
        Array.from(text).length,
      );
      const current = await f.invokeUpload("status", { uploadId: id });
      assert.deepEqual(current.upload, prepared.upload);
      const beginAgain = await f.invokeUpload("begin", started.input);
      assert.equal(beginAgain.upload.uploadId, id);
      assert.equal(await count(f, "project_source_uploads"), 1);
      const created = (await f.invoke(
        "createProject",
        novel(id, digest(bytes), "raw-http-adopt-first"),
      )) as ProjectFoundationMutationResponse;
      assert.ok(created.source);
      assert.equal(created.source.fileDigest, digest(bytes));
      assert.equal(created.source.characterLength, Array.from(text).length);
      const second = (await f.invoke(
        "createProject",
        novel(id, digest(bytes), "raw-http-adopt-second"),
      )) as ProjectFoundationMutationResponse;
      assert.notEqual(second.project.projectId, created.project.projectId);
      assert.equal(second.source?.digest, created.source.digest);
      assert.equal(await count(f, "project_source_upload_associations"), 2);
      const projectId = created.project.projectId,
        sourceRevision = created.source.revision,
        sourceDigest = created.source.digest;
      const chapterPage = await f.invoke("listSourceChapters", {
        projectId,
        sourceRevision,
        sourceDigest,
        afterStartOffset: null,
        limit: 1,
      });
      assert.ok("chapters" in chapterPage);
      assert.equal(chapterPage.chapters.length, 1);
      assert.equal(chapterPage.chapters[0]!.title, "第一章 雨夜");
      assert.notEqual(chapterPage.nextStartOffset, null);
      const nextChapter = await f.invoke("listSourceChapters", {
        projectId,
        sourceRevision,
        sourceDigest,
        afterStartOffset: chapterPage.nextStartOffset,
        limit: 1,
      });
      assert.ok("chapters" in nextChapter);
      assert.equal(nextChapter.chapters[0]!.title, "第二章 寻人");
      const sourcePage = await f.invoke("readSourcePage", {
        projectId,
        sourceRevision,
        sourceDigest,
        startOffset: 0,
        limit: 80,
      });
      assert.ok("page" in sourcePage);
      assert.equal(
        sourcePage.page.content,
        Array.from(text).slice(0, 80).join(""),
      );
      assert.equal(sourcePage.page.nextOffset, 80);
      assert.ok(
        f.state.uploadPermissions.includes("projectSourceUpload:adopt"),
      );
      assert.ok(
        f.state.uploadPermissions.includes("projectSourceUpload:write"),
      );
      assert.ok(f.authority.state.verifiedTlsConnections > 0);
      assert.equal(f.state.fallbackCalls, 0);
      const names = await f.f.tableNames();
      assert.equal(names.includes("runs"), false);
      assert.equal(names.includes("extension_tasks"), false);
    },
  );

  test(
    `${backend}: formal raw route rejects mount, bytes, MIME, query and undeclared JSON paths before persisting any part`,
    optionsFor(backend),
    async (t) => {
      const f = await foundationUiHttpFixture(t, backend, { uploads: true }),
        bytes = Buffer.from("# 雨夜\n正文");
      const { result } = await begin(f, bytes),
        exact = locator(result.upload.uploadId, 0, bytes);
      const path = projectSourceUploadPartPath(f.lease.mountRef, exact);
      const attempts = [
        () => f.partRaw(exact, bytes, { mountRef: "foreign-mount" }),
        () =>
          f.partRaw({ ...exact, rawDigest: `sha256:${"a".repeat(64)}` }, bytes),
        () => f.partRaw(exact, Buffer.alloc(65_537, 1)),
        () => f.partRaw(exact, bytes, { contentType: "text/plain" }),
        () => f.partRaw(exact, bytes, { url: `${path}?extra=true` }),
        () => f.partRaw(exact, bytes, { contentEncoding: "gzip" }),
        () => f.partRaw(exact, Buffer.alloc(0)),
        () =>
          f.invokeRaw("crewon.project-source-uploads.v1.writePart", {
            ...exact,
            bytes: [1, 2, 3],
          }),
        () => f.invokeRaw("crewon.project-source-uploads.v2.begin", {}),
        () => f.invokeRaw("crewon.project-source-uploads", {}),
      ];
      for (const attempt of attempts) {
        const response = await attempt();
        assert.notEqual(response.statusCode, 200, response.body);
        assert.equal(await count(f, "project_source_upload_parts"), 0);
        assert.equal(await count(f, "project_source_upload_part_payloads"), 0);
      }
      const current = await f.invokeUpload("status", {
        uploadId: exact.uploadId,
      });
      assert.equal(current.upload.phase, "receiving");
      assert.equal(current.upload.revision, 1);
      assert.equal(f.state.fallbackCalls, 0);
    },
  );

  test(
    `${backend}: upload PDP remains independent and installation withdrawal blocks raw and metadata without fallback`,
    optionsFor(backend),
    async (t) => {
      const f = await foundationUiHttpFixture(t, backend, { uploads: true }),
        bytes = Buffer.from("# 第一章 雨夜\n两人在雨夜重逢。");
      f.state.uploadBusinessAllowed = false;
      const denied = await f.invokeRaw(
        "crewon.project-source-uploads.v1.begin",
        {
          fileName: "雨夜.md",
          format: "md",
          byteLength: bytes.byteLength,
          fileDigest: digest(bytes),
          idempotencyKey: "raw-http-denied",
        },
      );
      assert.notEqual(denied.statusCode, 200);
      assert.equal(await count(f, "project_source_uploads"), 0);
      const creative = (await f.invoke("createProject", {
        title: "独立创意",
        briefText: "创意不需要原文。",
        origin: "creative",
        parameters: importParameters("creative"),
        creativeStartMode: "confirm-plan",
        sourceUpload: null,
        idempotencyKey: "raw-http-independent-creative",
      })) as ProjectFoundationMutationResponse;
      assert.equal(creative.foundation.origin, "creative");
      f.state.uploadBusinessAllowed = true;
      const { result } = await begin(f, bytes, "raw-http-business-withdraw"),
        part = locator(result.upload.uploadId, 0, bytes);
      f.state.uploadBusinessAllowed = false;
      assert.notEqual((await f.partRaw(part, bytes)).statusCode, 200);
      assert.equal(await count(f, "project_source_upload_parts"), 0);
      f.state.uploadBusinessAllowed = true;
      const written = await f.writePart(part, bytes);
      const prepared = await f.invokeUpload("prepare", {
        uploadId: part.uploadId,
        expectedRevision: written.upload.revision,
      });
      assert.equal(prepared.upload.phase, "ready");
      f.state.uploadBusinessAllowed = false;
      assert.notEqual(
        (
          await f.invokeRaw(
            "crewon.project-foundation.v1.createProject",
            novel(part.uploadId, digest(bytes), "raw-http-adopt-denied"),
          )
        ).statusCode,
        200,
      );
      assert.equal(await count(f, "project_source_upload_associations"), 0);
      assert.equal(await count(f, "project_foundations"), 1);
      f.state.uploadBusinessAllowed = true;
      await f.f.installations.commitSelection(
        selectionRecipe(f.enabled.selection, "raw-http-disable", {
          actor,
          state: "disabled",
        }),
      );
      assert.notEqual((await f.partRaw(part, bytes)).statusCode, 200);
      assert.notEqual(
        (
          await f.invokeRaw("crewon.project-source-uploads.v1.status", {
            uploadId: part.uploadId,
          })
        ).statusCode,
        200,
      );
      assert.notEqual(
        (
          await f.invokeRaw(
            "crewon.project-foundation.v1.createProject",
            novel(part.uploadId, digest(bytes), "raw-http-after-disable"),
          )
        ).statusCode,
        200,
      );
      assert.equal(await count(f, "project_source_upload_parts"), 1);
      assert.equal(await count(f, "project_source_upload_associations"), 0);
      assert.equal(f.state.fallbackCalls, 0);
    },
  );

  test(
    `${backend}: Foundation-only fixture keeps uploads unregistered and denies both protocol paths`,
    optionsFor(backend),
    async (t) => {
      const f = await foundationUiHttpFixture(t, backend),
        bytes = Buffer.from("原文");
      assert.equal(f.uploads, undefined);
      assert.notEqual(
        (
          await f.invokeRaw("crewon.project-source-uploads.v1.begin", {
            fileName: "原文.txt",
            format: "txt",
            byteLength: bytes.byteLength,
            fileDigest: digest(bytes),
            idempotencyKey: "raw-http-no-owner",
          })
        ).statusCode,
        200,
      );
      assert.notEqual(
        (await f.partRaw(locator("unissued-upload", 0, bytes), bytes))
          .statusCode,
        200,
      );
      assert.equal(await count(f, "project_source_uploads"), 0);
      assert.equal(await count(f, "project_source_upload_parts"), 0);
      assert.equal(f.state.fallbackCalls, 0);
    },
  );
}
