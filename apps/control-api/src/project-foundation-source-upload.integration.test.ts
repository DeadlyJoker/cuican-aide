import assert from "node:assert/strict";
import test from "node:test";
import type { PreparedProjectSource } from "@crewon/application";
import {
  checkPublicResponse,
  publicMutation,
} from "./project-foundation-import.test-support.ts";
import {
  adoptedNovel,
  adoptionFailure,
  prepareOwnedUpload,
  sourceAdoptionFixture,
} from "./project-foundation-source-upload.test-support.ts";
import {
  uploadActor,
  uploadAgent,
  uploadForeign,
  uploadHash,
} from "./project-source-upload.test-support.ts";

const story =
  "第一章 雨夜\r\n林雨😀收到未来的信。\r\n第二章 来信\r\n原著内核。";
const storyBytes = new TextEncoder().encode(story);
function json(value: unknown): Record<string, unknown> {
  return typeof value === "string"
    ? (JSON.parse(value) as Record<string, unknown>)
    : (value as Record<string, unknown>);
}
function forgedBody(source: PreparedProjectSource): PreparedProjectSource {
  const chunks = source.chunks.map((chunk, index) => {
    const content =
      index === 0 ? chunk.content.replace("雨", "雪") : chunk.content;
    return { ...chunk, content, digest: uploadHash(content) };
  });
  // Self-consistent hostile host output: the actual immutable SQL manifest must still reject it.
  return {
    ...source,
    chunks,
    digest: uploadHash(chunks.map((c) => c.content).join("")),
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip:
      backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL
        ? "isolated real PostgreSQL required"
        : false,
    timeout: 60_000,
  };
  test(
    `${backend}: actual twelve-part UTF16 upload is adopted atomically into the original project and cold receipt replay never reopens it`,
    options,
    async (t) => {
      const f = await sourceAdoptionFixture(t, backend);
      const original =
        "第一章 雨夜\r\n" +
        "林雨😀é线索。".repeat(46_000) +
        "\r\n第二章 来信\r\n终章。";
      const normalized = original.replaceAll("\r\n", "\n");
      const bytes = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(original, "utf16le"),
      ]);
      const uploaded = await prepareOwnedUpload(
        f.first.uploadService,
        bytes,
        "twelve-part-original",
      );
      assert.equal(uploaded.state.initial.partCount, 12);
      assert.equal(f.state.parserCalls, 1);
      const command = adoptedNovel(uploaded.reference, "twelve-part-novel");
      const created = await f.first.service.createProject(
        uploadAgent,
        command,
        f.authority(),
      );
      checkPublicResponse("createProject", command, publicMutation(created));
      const source = created.source!;
      const projectId = created.project.projectId;
      assert.equal(source.digest, uploadHash(normalized));
      assert.equal(source.fileDigest, uploadHash(bytes));
      assert.notEqual(source.digest, source.fileDigest);
      assert.equal(source.byteLength, bytes.length);
      assert.equal(source.characterLength, [...normalized].length);
      assert.ok(source.characterLength < normalized.length);
      assert.equal(source.createdByActorId, uploadAgent.actorId);
      assert.equal(created.foundation.parameters.episodeCount, 120);
      assert.equal(created.project.ownerPrincipalId, uploadActor.principalId);
      assert.equal(Object.hasOwn(source, "provenance"), false);
      const associations = await f.query(
        "SELECT * FROM $schema.project_source_upload_associations",
      );
      assert.equal(associations.length, 1);
      const association = json(associations[0]!.record_json);
      assert.equal(associations[0]!.project_id, projectId);
      assert.equal(Number(associations[0]!.source_revision), 1);
      assert.equal(associations[0]!.source_digest, source.digest);
      assert.equal(association.createdByActorId, uploadAgent.actorId);
      assert.deepEqual(association.pointer, uploaded.state.prepared!.pointer);
      assert.equal(association.fileDigest, source.fileDigest);
      assert.deepEqual(association.owner, uploaded.state.initial.owner);
      const chunkRows = await f.query(
        "SELECT start_offset FROM $schema.project_source_chunks WHERE project_id=$1 ORDER BY chunk_index LIMIT 2",
        [projectId],
      );
      assert.equal(chunkRows.length, 2);
      const startOffset = Number(chunkRows[1]!.start_offset) - 2;
      const pageQuery = {
        projectId,
        sourceRevision: 1,
        sourceDigest: source.digest,
        startOffset,
        limit: 13,
      };
      const page = await f.first.service.readSourcePage(uploadActor, pageQuery);
      checkPublicResponse("readSourcePage", pageQuery, { page });
      assert.equal(
        page.content,
        [...normalized].slice(startOffset, startOffset + 13).join(""),
      );
      assert.equal(page.endOffset - page.startOffset, 13);
      const chapters = await f.first.service.listSourceChapters(uploadAgent, {
        projectId,
        sourceRevision: 1,
        sourceDigest: source.digest,
        afterStartOffset: null,
        limit: 50,
      });
      assert.equal(chapters.chapters.length, 2);
      assert.equal(chapters.nextStartOffset, null);
      const counts = await f.counts();
      assert.equal(counts.creative_projects, 1);
      assert.equal(counts.creative_project_briefs, 1);
      assert.equal(counts.project_foundations, 1);
      assert.equal(counts.project_sources, 1);
      assert.equal(counts.project_source_upload_associations, 1);
      assert.equal(counts.project_foundation_mutation_receipts, 1);
      const reads = f.state.sourceReads;
      const ids = f.state.projectIds;
      const adoptedPermissions = f.state.permissions.filter(
        (p) => p.action === "projectSourceUpload:adopt",
      ).length;
      f.state.allowAdopt = false;
      await f.close();
      const reopened = await f.open();
      const replay = await reopened.service.createProject(
        uploadAgent,
        command,
        f.authority(),
      );
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual({ ...replay, disposition: "committed" }, created);
      assert.equal(f.state.sourceReads, reads);
      assert.equal(f.state.projectIds, ids);
      assert.equal(f.state.parserCalls, 1);
      assert.equal(
        f.state.permissions.filter(
          (p) => p.action === "projectSourceUpload:adopt",
        ).length,
        adoptedPermissions,
      );
      assert.deepEqual(await f.counts(), counts);
      assert.deepEqual(
        await reopened.service.readSourcePage(uploadAgent, pageQuery),
        page,
      );
      assert.deepEqual(
        await reopened.service.getSource(uploadActor, {
          projectId,
          sourceRevision: 1,
        }),
        source,
      );
      const status = await reopened.uploadService.getStatus(uploadActor, {
        uploadId: uploaded.reference.uploadId,
      });
      assert.equal(status.phase, "ready");
      assert.equal(Object.hasOwn(status, "consumed"), false);
    },
  );

  test(
    `${backend}: one prepared upload serves UI and Agent projects without consumption and read permission never grants adoption`,
    options,
    async (t) => {
      const f = await sourceAdoptionFixture(t, backend);
      const uploaded = await prepareOwnedUpload(
        f.first.uploadService,
        storyBytes,
        "shared-original",
      );
      const first = await f.first.service.createProject(
        uploadActor,
        adoptedNovel(uploaded.reference, "ui-project"),
        f.authority(),
      );
      const second = await f.first.service.createProject(
        uploadAgent,
        adoptedNovel(uploaded.reference, "agent-project"),
        f.authority(),
      );
      assert.notEqual(first.project.projectId, second.project.projectId);
      assert.equal(first.source!.digest, second.source!.digest);
      assert.equal(first.source!.createdByActorId, uploadActor.actorId);
      assert.equal(second.source!.createdByActorId, uploadAgent.actorId);
      assert.equal(f.state.parserCalls, 1);
      const counts = await f.counts();
      assert.equal(counts.project_source_uploads, 1);
      assert.equal(counts.project_source_upload_associations, 2);
      assert.equal(counts.project_sources, 2);
      f.state.allowAdopt = false;
      assert.equal(
        (
          await f.first.uploadService.getStatus(uploadAgent, {
            uploadId: uploaded.reference.uploadId,
          })
        ).phase,
        "ready",
      );
      await assert.rejects(
        f.first.service.createProject(
          uploadAgent,
          adoptedNovel(uploaded.reference, "read-is-not-adopt"),
          f.authority(),
        ),
        adoptionFailure("project_source_upload_permission_denied"),
      );
      assert.deepEqual(await f.counts(), counts);
      f.state.allowAdopt = true;
      await assert.rejects(
        f.first.service.createProject(
          uploadForeign,
          adoptedNovel(uploaded.reference, "foreign-owner"),
          f.authority(),
        ),
        adoptionFailure("project_source_upload_not_found"),
      );
      assert.deepEqual(await f.counts(), counts);
      assert.ok(
        f.state.permissions.some(
          (p) =>
            p.action === "projectSourceUpload:adopt" &&
            p.actor.actorId === uploadAgent.actorId &&
            p.resource.projectId === null,
        ),
      );
    },
  );

  test(
    `${backend}: exact raw digest and original SQL provenance reject hostile realm, pointer, metadata and self-consistent body without half projects`,
    options,
    async (t) => {
      const f = await sourceAdoptionFixture(t, backend);
      const uploaded = await prepareOwnedUpload(
        f.first.uploadService,
        storyBytes,
        "qualified-source",
      );
      const before = await f.counts();
      await assert.rejects(
        f.first.service.createProject(
          uploadActor,
          adoptedNovel(
            {
              ...uploaded.reference,
              fileDigest: uploadHash("forged raw bytes"),
            },
            "forged-file-digest",
          ),
          f.authority(),
        ),
        // The original adoption API deliberately combines readiness and exact raw digest.
        adoptionFailure("project_source_upload_not_ready"),
      );
      assert.deepEqual(await f.counts(), before);
      const cases: Array<{
        name: string;
        code: string;
        transform(source: PreparedProjectSource): PreparedProjectSource;
      }> = [
        {
          name: "missing-provenance",
          code: "project_foundation_source_provenance_required",
          transform(source) {
            const { provenance: unused, ...rest } = source;
            void unused;
            return rest;
          },
        },
        {
          name: "realm",
          code: "project_source_upload_ledger_mismatch",
          transform: (source) => ({
            ...source,
            provenance: {
              ...source.provenance!,
              storageRealmId: "different-original-database",
            },
          }),
        },
        {
          name: "prepared-pointer",
          code: "project_source_upload_ledger_mismatch",
          transform: (source) => ({
            ...source,
            provenance: {
              ...source.provenance!,
              preparedDigest: uploadHash("forged prepared manifest"),
            },
          }),
        },
        {
          name: "metadata",
          code: "project_source_upload_ledger_mismatch",
          transform: (source) => ({
            ...source,
            fileName: "another-original.txt",
          }),
        },
        {
          name: "body",
          code: "project_source_upload_ledger_mismatch",
          transform: forgedBody,
        },
      ];
      for (const candidate of cases) {
        f.state.transformPrepared = candidate.transform;
        await assert.rejects(
          f.first.service.createProject(
            uploadActor,
            adoptedNovel(uploaded.reference, `forged-${candidate.name}`),
            f.authority(),
          ),
          adoptionFailure(candidate.code),
          candidate.name,
        );
        assert.deepEqual(await f.counts(), before, candidate.name);
      }
      f.state.transformPrepared = null;
      const actual = await f.first.service.createProject(
        uploadActor,
        adoptedNovel(uploaded.reference, "after-hostile-attempts"),
        f.authority(),
      );
      assert.equal(
        actual.source!.digest,
        uploadHash(story.replaceAll("\r\n", "\n")),
      );
      assert.equal((await f.counts()).project_source_upload_associations, 1);
    },
  );

  test(
    `${backend}: append uses the exact existing-project adoption grant and invalidates confirmation in the same source association transaction`,
    options,
    async (t) => {
      const f = await sourceAdoptionFixture(t, backend);
      const original = await prepareOwnedUpload(
        f.first.uploadService,
        storyBytes,
        "original-book",
      );
      const created = await f.first.service.createProject(
        uploadActor,
        adoptedNovel(original.reference, "confirmed-novel"),
        f.authority(),
      );
      const projectId = created.project.projectId;
      const saved = await f.first.service.saveProposal(
        uploadAgent,
        {
          projectId,
          expectedFoundationRevision: 1,
          expectedProposalRevision: 0,
          kind: "novel-adaptation",
          text: "保留来信的悬疑内核，合并支线。",
          idempotencyKey: "original-adaptation",
        },
        f.authority(),
      );
      const proposal = saved.proposal!;
      const confirmed = await f.first.service.confirmProposal(
        uploadActor,
        {
          projectId,
          expectedFoundationRevision: saved.foundation.revision,
          proposalRevision: proposal.revision,
          proposalDigest: proposal.contentDigest,
          idempotencyKey: "confirm-original",
        },
        f.authority(),
      );
      assert.ok(confirmed.foundation.confirmedProposal);
      const replacement = await prepareOwnedUpload(
        f.first.uploadService,
        new TextEncoder().encode(story.replace("未来", "过去")),
        "revised-book",
      );
      const command = {
        projectId,
        expectedFoundationRevision: confirmed.foundation.revision,
        sourceUpload: replacement.reference,
        idempotencyKey: "append-revised",
      };
      const before = await f.counts();
      f.state.withdrawAdoptAfterAssociation = true;
      await assert.rejects(
        f.first.service.appendSource(uploadAgent, command, f.authority()),
        adoptionFailure("named-adopt-withdrawn"),
      );
      assert.equal(f.state.activeCreative, true);
      assert.equal(f.state.activeUpload, true);
      assert.equal(f.state.activeAdopt, false);
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(
        await f.first.service.getFoundation(uploadActor, { projectId }),
        confirmed.foundation,
      );
      f.state.withdrawAdoptAfterAssociation = false;
      f.state.activeAdopt = true;
      const appended = await f.first.service.appendSource(
        uploadAgent,
        command,
        f.authority(),
      );
      assert.equal(appended.source!.revision, 2);
      assert.equal(appended.foundation.source!.revision, 2);
      assert.equal(appended.foundation.confirmedProposal, null);
      assert.notEqual(appended.source!.digest, created.source!.digest);
      assert.deepEqual(
        await f.first.service.getSource(uploadActor, {
          projectId,
          sourceRevision: 1,
        }),
        created.source,
      );
      assert.equal((await f.counts()).project_source_upload_associations, 2);
      assert.equal((await f.counts()).project_sources, 2);
      assert.ok(
        f.state.permissions.some(
          (p) =>
            p.action === "projectSourceUpload:adopt" &&
            p.actor.actorId === uploadAgent.actorId &&
            p.resource.uploadId === replacement.reference.uploadId &&
            p.resource.projectId === projectId,
        ),
      );
      const counts = await f.counts();
      await assert.rejects(
        f.first.service.confirmProposal(
          uploadActor,
          {
            projectId,
            expectedFoundationRevision: appended.foundation.revision,
            proposalRevision: proposal.revision,
            proposalDigest: proposal.contentDigest,
            idempotencyKey: "stale-source-confirmation",
          },
          f.authority(),
        ),
        adoptionFailure("project_proposal_binding_stale"),
      );
      assert.deepEqual(await f.counts(), counts);
      assert.equal(
        (
          await f.first.service.getProposal(uploadAgent, {
            projectId,
            proposalRevision: proposal.revision,
          })
        ).text,
        proposal.text,
      );
    },
  );

  for (const withdrawal of ["creative", "adopt"] as const) {
    test(
      `${backend}: final ${withdrawal} authority withdrawal after actual association SQL rolls back every project/source/association/receipt row`,
      options,
      async (t) => {
        const f = await sourceAdoptionFixture(t, backend);
        const uploaded = await prepareOwnedUpload(
          f.first.uploadService,
          storyBytes,
          `${withdrawal}-withdraw-source`,
        );
        const before = await f.counts();
        if (withdrawal === "creative")
          f.state.withdrawCreativeAfterAssociation = true;
        else f.state.withdrawAdoptAfterAssociation = true;
        const command = adoptedNovel(
          uploaded.reference,
          `${withdrawal}-write-withdrawal`,
        );
        await assert.rejects(
          f.first.service.createProject(uploadAgent, command, f.authority()),
          adoptionFailure(`named-${withdrawal}-withdrawn`),
        );
        assert.equal(
          f.state.associationWrites,
          1,
          "original native SQL insert succeeded before synchronous final withdrawal",
        );
        assert.deepEqual(await f.counts(), before);
        assert.equal(f.state.activeUpload, true);
        assert.equal(f.state.activeCreative, withdrawal !== "creative");
        assert.equal(f.state.activeAdopt, withdrawal !== "adopt");
        f.state.withdrawCreativeAfterAssociation = false;
        f.state.withdrawAdoptAfterAssociation = false;
        f.state.activeCreative = true;
        f.state.activeAdopt = true;
        const retry = await f.first.service.createProject(
          uploadAgent,
          command,
          f.authority(),
        );
        assert.equal(retry.disposition, "committed");
        const counts = await f.counts();
        assert.equal(counts.creative_projects, 1);
        assert.equal(counts.project_sources, 1);
        assert.equal(counts.project_source_upload_associations, 1);
        assert.equal(counts.project_foundation_mutation_receipts, 1);
      },
    );
  }

  test(
    `${backend}: independent adoption withdrawal after confirmed original write COMMIT cannot negate the durable source association fact`,
    options,
    async (t) => {
      const f = await sourceAdoptionFixture(t, backend);
      const uploaded = await prepareOwnedUpload(
        f.first.uploadService,
        storyBytes,
        "after-commit-source",
      );
      const command = adoptedNovel(uploaded.reference, "after-commit-project");
      f.state.withdrawAdoptAfterWriteCommit = true;
      const created = await f.first.service.createProject(
        uploadAgent,
        command,
        f.authority(),
      );
      assert.equal(created.disposition, "committed");
      assert.equal(f.state.activeCreative, true);
      assert.equal(f.state.activeUpload, true);
      assert.equal(
        f.state.activeAdopt,
        false,
        "original native SQL COMMIT succeeded before withdrawal",
      );
      const counts = await f.counts();
      assert.equal(counts.project_source_upload_associations, 1);
      assert.equal(counts.project_sources, 1);
      assert.equal(counts.project_foundation_mutation_receipts, 1);
      f.state.withdrawAdoptAfterWriteCommit = false;
      await f.close();
      const reopened = await f.open();
      assert.deepEqual(
        await reopened.service.getFoundation(uploadActor, {
          projectId: created.project.projectId,
        }),
        created.foundation,
      );
      const reads = f.state.sourceReads;
      const replay = await reopened.service.createProject(
        uploadAgent,
        command,
        f.authority(),
      );
      assert.equal(replay.disposition, "replayed");
      assert.equal(f.state.sourceReads, reads);
      assert.deepEqual(await f.counts(), counts);
    },
  );
}
