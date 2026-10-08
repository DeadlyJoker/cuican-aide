import assert from "node:assert/strict";
import test from "node:test";
import {
  projectFoundationUiCodec,
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS,
  MAX_PROJECT_SOURCE_UI_CHAPTER_PAGE_SIZE,
} from "@crewon/contracts/project-foundation";
import {
  category,
  checkPublicResponse,
  foreignActor,
  foundationImportFixture,
  importActor,
  importAgent,
  importCreation,
  importHash,
  publicChapter,
  publicFoundation,
  publicMutation,
  publicProposal,
  publicSource,
} from "./project-foundation-import.test-support.ts";

function book(chapterCount = 64) {
  return Array.from(
    { length: chapterCount },
    (_, index) =>
      `第${index + 1}章 雨😀夜\r\n${"林雨 Café e\u0301 追寻线索😀。".repeat(20)}`,
  ).join("\r\n");
}
const textDocument = book();
const markdownDocument =
  "# 第一章 雨😀夜\r\n" +
  "林雨 Café e\u0301 追寻线索。".repeat(220) +
  "\r\n## 第二章 重逢\r\n结尾😀。";
const htmlBody = "人物 Café e\u0301 & 线索😀。".repeat(220);
const htmlDocument = `<html><head><title>站点标题</title><script>notAStory()</script></head><body><nav>导航</nav><h1>第一章 雨😀夜</h1><p>${htmlBody.replaceAll("&", "&amp;")}</p><h2>第二章 重逢</h2><p>结尾 &lt;线索&gt;😀。</p><footer>页脚</footer></body></html>`;
const documents = [
  {
    format: "txt" as const,
    fileName: "原著.txt",
    bytes: Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(textDocument, "utf16le"),
    ]),
    normalized: textDocument.replaceAll("\r\n", "\n"),
  },
  {
    format: "md" as const,
    fileName: "大纲.md",
    bytes: Buffer.from(markdownDocument),
    normalized: markdownDocument.replaceAll("\r\n", "\n"),
  },
  {
    format: "html" as const,
    fileName: "原著.html",
    bytes: Buffer.from(htmlDocument),
    normalized: `第一章 雨😀夜\n${htmlBody}\n第二章 重逢\n结尾 <线索>😀。`,
  },
];

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 60_000,
  };

  test(
    `${backend}: real TXT/MD/HTML bytes become immutable sources, bounded pages and portable public DTOs`,
    options,
    async (t) => {
      const f = await foundationImportFixture(t, backend);
      const { service } = f.first;
      for (const document of documents) {
        const prepared = f.stage(`upload-${document.format}`, document);
        assert.equal(prepared.byteLength, document.bytes.byteLength);
        assert.equal(prepared.fileDigest, importHash(document.bytes));
        assert.equal(prepared.digest, importHash(document.normalized));
        assert.notEqual(prepared.fileDigest, prepared.digest);
        assert.equal(prepared.characterLength, [...document.normalized].length);
        assert.ok(
          prepared.characterLength < document.normalized.length,
          "emoji offsets count scalars, not UTF-16 units",
        );
        assert.ok(prepared.chunks.length > 1);
        const command = importCreation(
          "novel",
          `import-${document.format}`,
          prepared,
        );
        const created = await service.createProject(
          importActor,
          command,
          f.authority(),
        );
        checkPublicResponse("createProject", command, publicMutation(created));
        assert.equal(created.foundation.parameters.episodeCount, 120);
        assert.equal(created.project.revision, 2);
        assert.equal(Object.hasOwn(created.project, "origin"), false);
        assert.equal(created.source!.digest, prepared.digest);
        const projectId = created.project.projectId;
        const sourceQuery = { projectId, sourceRevision: 1 };
        const source = await service.getSource(importAgent, sourceQuery);
        assert.deepEqual(source, created.source);
        checkPublicResponse("getSource", sourceQuery, {
          source: publicSource(source),
        });
        const foundation = await service.getFoundation(importAgent, {
          projectId,
        });
        assert.deepEqual(foundation, created.foundation);
        checkPublicResponse(
          "getFoundation",
          { projectId },
          { foundation: publicFoundation(foundation!) },
        );
        let offset: number | null = 0;
        const parts: string[] = [];
        while (offset !== null) {
          const query = {
            ...sourceQuery,
            sourceDigest: source.digest,
            startOffset: offset,
            limit: 1024,
          };
          const page = await service.readSourcePage(importAgent, query);
          checkPublicResponse("readSourcePage", query, { page });
          assert.ok([...page.content].length <= 1024);
          assert.equal(
            page.endOffset - page.startOffset,
            [...page.content].length,
          );
          parts.push(page.content);
          offset = page.nextOffset;
        }
        assert.equal(parts.join(""), document.normalized);
        const startOffset = prepared.chunks[1]!.startOffset - 2;
        const crossing = await service.readSourcePage(importActor, {
          ...sourceQuery,
          sourceDigest: source.digest,
          startOffset,
          limit: 9,
        });
        assert.equal(
          crossing.content,
          [...document.normalized].slice(startOffset, startOffset + 9).join(""),
        );
        const tail = await service.readSourcePage(importActor, {
          ...sourceQuery,
          sourceDigest: source.digest,
          startOffset: source.characterLength,
          limit: 1024,
        });
        assert.equal(tail.content, "");
        assert.equal(tail.nextOffset, null);
        let afterStartOffset: number | null = null;
        const titles: string[] = [];
        do {
          const query = {
            ...sourceQuery,
            sourceDigest: source.digest,
            afterStartOffset,
            limit: MAX_PROJECT_SOURCE_UI_CHAPTER_PAGE_SIZE,
          };
          const page = await service.listSourceChapters(importAgent, query);
          checkPublicResponse("listSourceChapters", query, {
            chapters: page.chapters.map(publicChapter),
            nextStartOffset: page.nextStartOffset,
          });
          titles.push(...page.chapters.map((chapter) => chapter.title));
          afterStartOffset = page.nextStartOffset;
        } while (afterStartOffset !== null);
        assert.deepEqual(
          titles,
          prepared.chapters.map((chapter) => chapter.title),
        );
        assert.notEqual(
          titles.length,
          created.foundation.parameters.episodeCount,
          "original chapters are independent of produced episodes",
        );
        await assert.rejects(
          service.readSourcePage(importActor, {
            ...sourceQuery,
            sourceDigest: importHash("wrong source"),
            startOffset: 0,
            limit: 8,
          }),
          category("conflict"),
        );
        await assert.rejects(
          service.readSourcePage(importActor, {
            ...sourceQuery,
            sourceDigest: source.digest,
            startOffset: 0,
            limit: 1025,
          }),
          category("validation"),
        );
      }
      const counts = await f.counts();
      assert.equal(counts.creative_projects, documents.length);
      assert.equal(counts.project_sources, documents.length);
      assert.equal(counts.project_proposals, 0);
      assert.equal(
        counts.project_foundation_mutation_receipts,
        documents.length,
      );
    },
  );

  test(
    `${backend}: a 120-episode novel survives real host reopen and receipt replay without reopening uploads`,
    options,
    async (t) => {
      const f = await foundationImportFixture(t, backend);
      const prepared = f.stage("novel-upload", documents[0]!);
      const command = importCreation("novel", "novel-cold-replay", prepared);
      const created = await f.first.service.createProject(
        importActor,
        command,
        f.authority(),
      );
      const projectId = created.project.projectId;
      const save = {
        projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "novel-adaptation" as const,
        text: "保留林雨与雨夜重逢，合并支线。120集，每集2–5分钟。",
        idempotencyKey: "save-adaptation",
      };
      const saved = await f.first.service.saveProposal(
        importAgent,
        save,
        f.authority(),
      );
      checkPublicResponse("saveProposal", save, publicMutation(saved));
      assert.equal(saved.proposal!.createdByActorId, importAgent.actorId);
      assert.equal(saved.foundation.confirmedProposal, null);
      const confirm = {
        projectId,
        expectedFoundationRevision: 1,
        proposalRevision: 1,
        proposalDigest: saved.proposal!.contentDigest,
        idempotencyKey: "confirm-adaptation",
      };
      const confirmed = await f.first.service.confirmProposal(
        importActor,
        confirm,
        f.authority(),
      );
      checkPublicResponse(
        "confirmProposal",
        confirm,
        publicMutation(confirmed),
      );
      assert.equal(confirmed.foundation.revision, 2);
      const before = await f.counts();
      const readCount = f.state.sourceReads,
        idCount = f.state.idCalls;
      await f.first.close();
      f.uploads.clear();
      const reopened = await f.open();
      assert.deepEqual(
        await reopened.service.getFoundation(importActor, { projectId }),
        confirmed.foundation,
      );
      for (const [method, input, expected] of [
        ["createProject", command, created],
        ["saveProposal", save, saved],
        ["confirmProposal", confirm, confirmed],
      ] as const) {
        const replayed =
          method === "createProject"
            ? await reopened.service.createProject(
                importActor,
                command,
                f.authority(),
              )
            : method === "saveProposal"
              ? await reopened.service.saveProposal(
                  importAgent,
                  save,
                  f.authority(),
                )
              : await reopened.service.confirmProposal(
                  importActor,
                  confirm,
                  f.authority(),
                );
        assert.deepEqual(replayed, { ...expected, disposition: "replayed" });
        checkPublicResponse(method, input, publicMutation(replayed));
      }
      assert.equal(f.state.sourceReads, readCount);
      assert.equal(f.state.idCalls, idCount);
      assert.deepEqual(await f.counts(), before);
      const proposalQuery = { projectId, proposalRevision: 1 };
      const actualProposal = await reopened.service.getProposal(
        importAgent,
        proposalQuery,
      );
      assert.deepEqual(actualProposal, saved.proposal);
      checkPublicResponse("getProposal", proposalQuery, {
        proposal: publicProposal(actualProposal),
      });
      const listQuery = { projectId, afterProposalRevision: 0, limit: 1 };
      const proposalPage = await reopened.service.listProposals(
        importAgent,
        listQuery,
      );
      checkPublicResponse("listProposals", listQuery, {
        proposals: proposalPage.proposals.map(publicProposal),
        nextRevision: proposalPage.nextRevision,
      });
      assert.equal(proposalPage.nextRevision, null);
      const readQuery = {
        projectId,
        sourceRevision: 1,
        sourceDigest: prepared.digest,
        startOffset: prepared.chunks[1]!.startOffset - 1,
        limit: 8,
      };
      const page = await reopened.service.readSourcePage(
        importAgent,
        readQuery,
      );
      assert.equal(
        page.content,
        [...documents[0]!.normalized]
          .slice(readQuery.startOffset, readQuery.startOffset + 8)
          .join(""),
      );
      checkPublicResponse("readSourcePage", readQuery, { page });
      f.state.allow = false;
      await assert.rejects(
        reopened.service.createProject(importActor, command, f.authority()),
        category("authorization"),
      );
      assert.deepEqual(await f.counts(), before);
    },
  );

  test(
    `${backend}: source and parameter changes invalidate old proposals and concurrent CAS preserves one actual winner`,
    options,
    async (t) => {
      const f = await foundationImportFixture(t, backend);
      const source = f.stage("original", documents[0]!);
      const { service } = f.first;
      const created = await service.createProject(
        importActor,
        importCreation("novel", "novel-changes", source),
        f.authority(),
      );
      const projectId = created.project.projectId;
      const save = {
        projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "novel-adaptation" as const,
        text: "第一版改编方案。",
        idempotencyKey: "old-plan",
      };
      const saved = await service.saveProposal(
        importAgent,
        save,
        f.authority(),
      );
      const confirm = {
        projectId,
        expectedFoundationRevision: 1,
        proposalRevision: 1,
        proposalDigest: saved.proposal!.contentDigest,
        idempotencyKey: "old-confirm",
      };
      await service.confirmProposal(importActor, confirm, f.authority());
      const parameters = {
        ...created.foundation.parameters,
        episodeCount: 121,
      };
      const update = {
        projectId,
        expectedFoundationRevision: 2,
        parameters,
        idempotencyKey: "update-count",
      };
      const updated = await service.updateParameters(
        importActor,
        update,
        f.authority(),
      );
      checkPublicResponse("updateParameters", update, publicMutation(updated));
      assert.equal(updated.foundation.parametersRevision, 2);
      assert.equal(updated.foundation.confirmedProposal, null);
      const beforeInvalid = await f.counts();
      await assert.rejects(
        service.confirmProposal(
          importActor,
          {
            ...confirm,
            expectedFoundationRevision: 3,
            idempotencyKey: "confirm-stale-parameters",
          },
          f.authority(),
        ),
        category("conflict"),
      );
      assert.deepEqual(await f.counts(), beforeInvalid);
      const currentSave = {
        ...save,
        expectedFoundationRevision: 3,
        expectedProposalRevision: 1,
        text: "第二版按121集改编。",
        idempotencyKey: "new-plan",
      };
      const currentPlan = await service.saveProposal(
        importAgent,
        currentSave,
        f.authority(),
      );
      const replacement = f.stage("replacement", documents[1]!);
      const append = {
        projectId,
        expectedFoundationRevision: 3,
        sourceUpload: {
          uploadId: replacement.uploadId,
          fileDigest: replacement.fileDigest,
        },
        idempotencyKey: "append-new-source",
      };
      const appended = await service.appendSource(
        importActor,
        append,
        f.authority(),
      );
      checkPublicResponse("appendSource", append, publicMutation(appended));
      assert.equal(appended.source!.revision, 2);
      assert.equal(appended.foundation.parametersRevision, 2);
      assert.equal(appended.foundation.confirmedProposal, null);
      const beforeSourceInvalid = await f.counts();
      await assert.rejects(
        service.confirmProposal(
          importActor,
          {
            projectId,
            expectedFoundationRevision: 4,
            proposalRevision: 2,
            proposalDigest: currentPlan.proposal!.contentDigest,
            idempotencyKey: "confirm-stale-source",
          },
          f.authority(),
        ),
        category("conflict"),
      );
      assert.deepEqual(await f.counts(), beforeSourceInvalid);
      assert.deepEqual(
        await service.getProposal(importActor, {
          projectId,
          proposalRevision: 1,
        }),
        saved.proposal,
      );
      assert.equal(
        (await service.getSource(importAgent, { projectId, sourceRevision: 1 }))
          .digest,
        source.digest,
      );
      const winners = await Promise.allSettled(
        [122, 123].map((episodeCount) =>
          service.updateParameters(
            importActor,
            {
              projectId,
              expectedFoundationRevision: 4,
              parameters: { ...parameters, episodeCount },
              idempotencyKey: `race-${episodeCount}`,
            },
            f.authority(),
          ),
        ),
      );
      assert.equal(
        winners.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failure = winners.find((result) => result.status === "rejected")!;
      assert.ok(
        failure.status === "rejected" && category("conflict")(failure.reason),
      );
      const current = await service.getFoundation(importActor, { projectId });
      assert.equal(current!.revision, 5);
      assert.ok([122, 123].includes(current!.parameters.episodeCount!));
      const counts = await f.counts();
      assert.equal(
        counts.project_foundation_mutation_receipts,
        beforeSourceInvalid.project_foundation_mutation_receipts! + 1,
      );
      assert.equal(counts.project_sources, 2);
      assert.equal(counts.project_proposals, 2);
      assert.equal(counts.creative_projects, 1);
    },
  );

  test(
    `${backend}: creative project confirmations, no-op edits and explicit single-episode direct start retain original project data`,
    options,
    async (t) => {
      const f = await foundationImportFixture(t, backend);
      const { service } = f.first;
      const command = importCreation("creative", "creative-plan");
      const created = await service.createProject(
        importActor,
        command,
        f.authority(),
      );
      checkPublicResponse("createProject", command, publicMutation(created));
      const projectId = created.project.projectId;
      const save = {
        projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "creative-plan" as const,
        text: "三集悬疑方案：收到信、寻找作者、面对自己。",
        idempotencyKey: "creative-proposal",
      };
      const saved = await service.saveProposal(
        importAgent,
        save,
        f.authority(),
      );
      checkPublicResponse("saveProposal", save, publicMutation(saved));
      const confirm = {
        projectId,
        expectedFoundationRevision: 1,
        proposalRevision: 1,
        proposalDigest: saved.proposal!.contentDigest,
        idempotencyKey: "creative-confirm",
      };
      const confirmed = await service.confirmProposal(
        importActor,
        confirm,
        f.authority(),
      );
      checkPublicResponse(
        "confirmProposal",
        confirm,
        publicMutation(confirmed),
      );
      const noOp = {
        projectId,
        expectedFoundationRevision: 2,
        parameters: command.parameters,
        idempotencyKey: "same-parameters",
      };
      const unchanged = await service.updateParameters(
        importActor,
        noOp,
        f.authority(),
      );
      assert.deepEqual(unchanged.foundation, confirmed.foundation);
      checkPublicResponse("updateParameters", noOp, publicMutation(unchanged));
      const sameMode = {
        projectId,
        expectedFoundationRevision: 2,
        creativeStartMode: "confirm-plan" as const,
        idempotencyKey: "same-start-mode",
      };
      const noModeChange = await service.chooseCreativeStartMode(
        importActor,
        sameMode,
        f.authority(),
      );
      assert.deepEqual(noModeChange.foundation, confirmed.foundation);
      checkPublicResponse(
        "chooseCreativeStartMode",
        sameMode,
        publicMutation(noModeChange),
      );
      const direct = {
        ...sameMode,
        creativeStartMode: "direct-script" as const,
        idempotencyKey: "choose-direct",
      };
      const directResult = await service.chooseCreativeStartMode(
        importActor,
        direct,
        f.authority(),
      );
      checkPublicResponse(
        "chooseCreativeStartMode",
        direct,
        publicMutation(directResult),
      );
      assert.equal(directResult.foundation.revision, 3);
      assert.equal(directResult.foundation.confirmedProposal, null);
      assert.deepEqual(directResult.project, created.project);
      const single = {
        ...importCreation("creative", "creative-single"),
        creativeStartMode: "direct-script" as const,
        parameters: {
          ...command.parameters,
          episodeMode: "single" as const,
          episodeCount: 1,
        },
      };
      const singleCreated = await service.createProject(
        importActor,
        single,
        f.authority(),
      );
      checkPublicResponse(
        "createProject",
        single,
        publicMutation(singleCreated),
      );
      assert.equal(singleCreated.foundation.parameters.episodeMode, "single");
      assert.equal(singleCreated.foundation.source, null);
      assert.equal(f.state.sourceReads, 0);
      const counts = await f.counts();
      assert.equal(counts.creative_projects, 2);
      assert.equal(counts.creative_project_briefs, 2);
      assert.equal(counts.project_sources, 0);
    },
  );

  test(
    `${backend}: owner-bound uploads, original-byte digest pins and public codec exclude foreign or private data`,
    options,
    async (t) => {
      const f = await foundationImportFixture(t, backend);
      const prepared = f.stage("owned-upload", documents[0]!);
      const { service } = f.first;
      const command = importCreation("novel", "owned-project", prepared);
      const created = await service.createProject(
        importActor,
        command,
        f.authority(),
      );
      const projectId = created.project.projectId;
      const before = await f.counts();
      const sourceQuery = {
        projectId,
        sourceRevision: 1,
        sourceDigest: prepared.digest,
        startOffset: 0,
        limit: 10,
      };
      const chapterQuery = {
        projectId,
        sourceRevision: 1,
        sourceDigest: prepared.digest,
        afterStartOffset: null,
        limit: 50,
      };
      for (const foreign of [
        foreignActor,
        {
          ...foreignActor,
          tenantId: "other-tenant",
          principalId: importActor.principalId,
        },
        {
          ...foreignActor,
          spaceId: "other-space",
          principalId: importActor.principalId,
        },
      ]) {
        await assert.rejects(
          service.getFoundation(foreign, { projectId }),
          category("notFound"),
        );
        await assert.rejects(
          service.getSource(foreign, { projectId, sourceRevision: 1 }),
          category("notFound"),
        );
        await assert.rejects(
          service.readSourcePage(foreign, sourceQuery),
          category("notFound"),
        );
        await assert.rejects(
          service.listSourceChapters(foreign, chapterQuery),
          category("notFound"),
        );
        await assert.rejects(
          service.createProject(
            foreign,
            {
              ...command,
              idempotencyKey: `foreign-${foreign.tenantId}-${foreign.spaceId}`,
            },
            f.authority(),
          ),
          category("notFound"),
        );
      }
      await assert.rejects(
        service.createProject(
          importActor,
          {
            ...command,
            sourceUpload: {
              uploadId: prepared.uploadId,
              fileDigest: importHash("foreign bytes"),
            },
            idempotencyKey: "wrong-file-pin",
          },
          f.authority(),
        ),
        category("conflict"),
      );
      assert.deepEqual(await f.counts(), before);
      checkPublicResponse("createProject", command, publicMutation(created));
      const expected = {
        action: PROJECT_FOUNDATION_UI_METHOD_ACTIONS.createProject,
        input: command,
      };
      assert.throws(
        () => projectFoundationUiCodec.parseResponse(created, expected),
        "internal domain records must not be serialized as public DTOs",
      );
      const published = publicMutation(created);
      assert.throws(() =>
        projectFoundationUiCodec.parseResponse(
          {
            ...published,
            source: { ...published.source!, tenantId: importActor.tenantId },
          },
          expected,
        ),
      );
      f.state.allow = false;
      const readsBeforeDeny = f.state.sourceReads;
      await assert.rejects(
        service.createProject(
          importActor,
          { ...command, idempotencyKey: "policy-denied" },
          f.authority(),
        ),
        category("authorization"),
      );
      assert.equal(f.state.sourceReads, readsBeforeDeny);
      assert.deepEqual(await f.counts(), before);
    },
  );
}
