import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ProjectFoundationMutationResponse } from "@crewon/contracts/project-foundation";
import { foundationUiHttpFixture } from "./project-foundation-plugin-ui.integration.test-support.ts";
import { importParameters } from "./project-foundation-import.test-support.ts";
import {
  actor,
  optionsFor,
} from "../../../packages/store/src/creative-project-plugin-commit.test-support.ts";
import { foundationMetadataFixture } from "../../../packages/store/src/project-foundation-legacy-access.test-support.ts";
const digest = (b: Uint8Array) =>
  `sha256:${createHash("sha256").update(b).digest("hex")}`;
const novel = (id: string, bytes: Uint8Array, key: string) => ({
  title: "雨夜",
  briefText: "保留主线",
  origin: "novel" as const,
  parameters: importParameters("novel"),
  creativeStartMode: null,
  sourceUpload: { uploadId: id, fileDigest: digest(bytes) },
  idempotencyKey: key,
});
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: real mounted upload/Foundation protocols deny associated protected source, replay and copy while independent upload stays available`,
    optionsFor(backend),
    async (t) => {
      const f = await foundationUiHttpFixture(t, backend, { uploads: true }),
        bytes = Buffer.from("# 第一章 雨夜\n两人在雨夜重逢。");
      async function upload(key: string) {
        const input = {
          fileName: "story.md",
          format: "md" as const,
          byteLength: bytes.byteLength,
          fileDigest: digest(bytes),
          idempotencyKey: key,
        };
        const started = await f.invokeUpload("begin", input),
          id = started.upload.uploadId;
        const written = await f.writePart(
          { uploadId: id, partIndex: 0, rawDigest: digest(bytes) },
          bytes,
        );
        const prepared = await f.invokeUpload("prepare", {
          uploadId: id,
          expectedRevision: written.upload.revision,
        });
        assert.equal(prepared.upload.phase, "ready");
        return { id, input, prepared };
      }
      const original = await upload("isolation-http-original");
      const a = (await f.invoke(
        "createProject",
        novel(original.id, bytes, "isolation-http-a"),
      )) as ProjectFoundationMutationResponse;
      const bCommand = novel(original.id, bytes, "isolation-http-b"),
        b = (await f.invoke(
          "createProject",
          bCommand,
        )) as ProjectFoundationMutationResponse;
      const proposalCommand = {
        projectId: b.project.projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "novel-adaptation" as const,
        text: "保留来信主线",
        idempotencyKey: "isolation-http-proposal",
      };
      const proposal = (await f.invoke(
        "saveProposal",
        proposalCommand,
      )) as ProjectFoundationMutationResponse;
      assert.equal(proposal.source, null);
      assert.equal(proposal.foundation.source!.revision, 1);
      const path =
        backend === "sqlite"
          ? String(
              f.f
                .database!.prepare("PRAGMA database_list")
                .all()
                .find((row) => row.name === "main")!.file,
            )
          : "";
      const metadata = await foundationMetadataFixture(t, {
        backend,
        path,
        schema: f.f.schema,
        prefix: f.f.prefix,
      });
      await metadata.migrate();
      const before = await f.f.query(
        `SELECT * FROM ${f.f.prefix}project_foundation_mutation_receipts ORDER BY idempotency_key`,
      );
      await metadata.mark(a.project.projectId, actor);
      const attempts = [
        () =>
          f.invokeRaw("crewon.project-source-uploads.v1.status", {
            uploadId: original.id,
          }),
        () =>
          f.invokeRaw("crewon.project-source-uploads.v1.begin", original.input),
        () =>
          f.invokeRaw("crewon.project-source-uploads.v1.prepare", {
            uploadId: original.id,
            expectedRevision: original.prepared.upload.revision,
          }),
        () =>
          f.partRaw(
            { uploadId: original.id, partIndex: 0, rawDigest: digest(bytes) },
            bytes,
          ),
        () =>
          f.invokeRaw("crewon.project-foundation.v1.createProject", bCommand),
        () =>
          f.invokeRaw(
            "crewon.project-foundation.v1.saveProposal",
            proposalCommand,
          ),
        () =>
          f.invokeRaw(
            "crewon.project-foundation.v1.createProject",
            novel(original.id, bytes, "isolation-http-c"),
          ),
        () =>
          f.invokeRaw("crewon.project-foundation.v1.readSourcePage", {
            projectId: b.project.projectId,
            sourceRevision: 1,
            sourceDigest: b.source!.digest,
            startOffset: 0,
            limit: 10,
          }),
        () =>
          f.invokeRaw("crewon.project-foundation.v1.listSourceChapters", {
            projectId: b.project.projectId,
            sourceRevision: 1,
            sourceDigest: b.source!.digest,
            afterStartOffset: null,
            limit: 1,
          }),
      ];
      for (const attempt of attempts) {
        const response = await attempt();
        assert.notEqual(response.statusCode, 200, response.body);
        assert.equal(response.body.includes("两人在雨夜重逢"), false);
      }
      assert.deepEqual(
        await f.f.query(
          `SELECT * FROM ${f.f.prefix}project_foundation_mutation_receipts ORDER BY idempotency_key`,
        ),
        before,
      );
      assert.equal(
        Number(
          (
            await f.f.query(
              `SELECT count(*) AS n FROM ${f.f.prefix}project_source_upload_associations`,
            )
          )[0]!.n,
        ),
        2,
      );
      const independent = await upload("isolation-http-independent");
      const c = (await f.invoke(
        "createProject",
        novel(independent.id, bytes, "isolation-http-independent-project"),
      )) as ProjectFoundationMutationResponse;
      assert.ok(c.source);
      assert.notEqual(c.project.projectId, b.project.projectId);
      assert.equal(f.state.fallbackCalls, 0);
      assert.ok(f.authority.state.verifiedTlsConnections > 0);
    },
  );
}
