import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parseProjectOutlineUiRequest,
  parseProjectOutlineUiResponse,
  type ProjectOutlineSectionResponse,
  type ProjectOutlineView,
} from "@crewon/contracts/project-outlines";
import type { ProjectFoundationMutationResponse } from "@crewon/contracts/project-foundation";
import { parseProjectOutlineDocument } from "@crewon/domain";
import { foundationUiHttpFixture } from "./project-foundation-plugin-ui.integration.test-support.ts";
import { importParameters } from "./project-foundation-import.test-support.ts";
import {
  actor,
  optionsFor,
  selectionRecipe,
} from "../../../packages/store/src/creative-project-plugin-commit.test-support.ts";
import { longOutlineDocument } from "../../../packages/store/src/project-structured-outline.test-support.ts";

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: installed outline reads traverse actual HTTP identity and original SQL, page complete content and stop on withdrawal`,
    { ...optionsFor(backend), timeout: 30_000 },
    async (t) => {
      const f = await foundationUiHttpFixture(t, backend, {
        uploads: true,
        outlines: true,
      });
      const original = longOutlineDocument();
      const document = parseProjectOutlineDocument({
        ...original,
        episodes: original.episodes.map((episode, index) => ({
          ...episode,
          summary:
            Array.from(episode.summary).slice(0, 120).join("") +
            (index < 8 ? "完整保留正文与空行。\n\n".repeat(180) : ""),
        })),
      });
      const evidence = [
        ...document.adaptation.keep,
        ...document.adaptation.cut,
        ...document.adaptation.merge,
      ].flatMap((item) => (item.evidence ? [item.evidence] : []));
      const bytes = Buffer.from("# 第一章 渡口\n" + evidence.join("\n\n"));
      const begun = await f.invokeUpload("begin", {
        fileName: "渡口.md",
        format: "md",
        byteLength: bytes.byteLength,
        fileDigest: digest(bytes),
        idempotencyKey: "outline-read-source",
      });
      const written = await f.writePart(
        {
          uploadId: begun.upload.uploadId,
          partIndex: 0,
          rawDigest: digest(bytes),
        },
        bytes,
      );
      const prepared = await f.invokeUpload("prepare", {
        uploadId: begun.upload.uploadId,
        expectedRevision: written.upload.revision,
      });
      assert.equal(prepared.upload.phase, "ready");
      const created = (await f.invoke("createProject", {
        title: document.title,
        briefText: "按原文改编，完整保留实际分集成果。",
        origin: "novel",
        parameters: {
          ...importParameters("novel"),
          genre: document.params.genre,
          episodeCount: document.params.episodes,
          episodeDurationSeconds: {
            minimum: Math.round(document.params.minutesPerEpisode * 60),
            maximum: Math.round(document.params.minutesPerEpisode * 60),
          },
          adaptation: {
            strategy: "core",
            retainedCharacters: [],
            retainedScenes: [],
          },
        },
        creativeStartMode: null,
        sourceUpload: {
          uploadId: begun.upload.uploadId,
          fileDigest: digest(bytes),
        },
        idempotencyKey: "outline-read-project",
      })) as ProjectFoundationMutationResponse;
      const projectId = created.project.projectId;
      const proposal = (await f.invoke("saveProposal", {
        projectId,
        expectedFoundationRevision: created.foundation.revision,
        expectedProposalRevision: 0,
        kind: "novel-adaptation",
        text: "以渡口事件为核心，按120集展开人物秘密。",
        idempotencyKey: "outline-read-proposal",
      })) as ProjectFoundationMutationResponse;
      assert.ok(proposal.proposal);
      await f.invoke("confirmProposal", {
        projectId,
        expectedFoundationRevision: created.foundation.revision,
        proposalRevision: proposal.proposal.revision,
        proposalDigest: proposal.proposal.contentDigest,
        idempotencyKey: "outline-read-confirm",
      });
      assert.ok(f.projects.structuredOutlineService);
      const service = f.projects.structuredOutlineService;
      let saved = await service.saveCandidate(actor, {
        projectId,
        expectedArtifactRevision: 0,
        briefRevision: created.brief!.briefRevision,
        base: null,
        change: {
          kind: "initialize",
          document: { ...document, episodes: [], beats: [] },
        },
        idempotencyKey: "outline-read-initialize",
      });
      for (const collection of ["episodes", "beats"] as const) {
        for (let at = 0; at < document[collection].length; at += 4) {
          saved = await service.saveCandidate(actor, {
            projectId,
            expectedArtifactRevision: saved.artifact.revision,
            briefRevision: created.brief!.briefRevision,
            base: {
              contentRevision: saved.contentRevision!.contentRevision,
              contentDigest: saved.contentRevision!.contentDigest,
            },
            change:
              collection === "episodes"
                ? {
                    kind: "upsert",
                    collection,
                    items: document.episodes.slice(at, at + 4),
                    removeIds: [],
                  }
                : {
                    kind: "upsert",
                    collection,
                    items: document.beats.slice(at, at + 4),
                    removeIds: [],
                  },
            idempotencyKey: `outline-read-${collection}-${at}`,
          });
        }
      }
      await service.selectRevision(actor, {
        projectId,
        artifactId: saved.artifact.artifactId,
        expectedArtifactRevision: saved.artifact.revision,
        contentRevision: saved.contentRevision!.contentRevision,
        idempotencyKey: "outline-read-adopt",
      });
      const invoke = async (action: string, input: unknown) => {
        const request = parseProjectOutlineUiRequest({ action, input });
        const result = await f.invokeRaw(action, input);
        assert.equal(result.statusCode, 200, result.body);
        return parseProjectOutlineUiResponse(request, result.json().output);
      };
      const result = (await invoke("crewon.project-outlines.v2.getOutline", {
        projectId,
      })) as { view: ProjectOutlineView };
      assert.equal(result.view.selectedRevision!.format, "structured-v2");
      assert.equal(result.view.selectedRevision!.counts.episodes, 120);
      const revision = result.view.selectedRevision!;
      const query = {
        projectId,
        artifactId: revision.artifactId,
        contentRevision: revision.contentRevision,
        contentDigest: revision.contentDigest,
        section: "episodes" as const,
        afterIndex: 0,
        limit: 10,
      };
      const page = (await invoke(
        "crewon.project-outlines.v2.getSection",
        query,
      )) as ProjectOutlineSectionResponse;
      assert.ok(Buffer.byteLength(JSON.stringify(page)) > 24 * 1024);
      assert.deepEqual(
        page.items,
        document.episodes.slice(0, page.items.length),
      );
      assert.equal(page.nextIndex, page.items.length);
      assert.equal(page.totalItems, 120);
      const next = (await invoke("crewon.project-outlines.v2.getSection", {
        ...query,
        afterIndex: page.nextIndex,
      })) as ProjectOutlineSectionResponse;
      assert.deepEqual(
        next.items,
        document.episodes.slice(
          page.items.length,
          page.items.length + next.items.length,
        ),
      );
      for (const change of [
        { contentDigest: `sha256:${"f".repeat(64)}` },
        { projectId: "foreign-project" },
        { artifactId: "foreign-artifact" },
        { afterIndex: 121 },
      ])
        assert.notEqual(
          (
            await f.invokeRaw("crewon.project-outlines.v2.getSection", {
              ...query,
              ...change,
            })
          ).statusCode,
          200,
        );
      f.state.businessAllowed = false;
      assert.notEqual(
        (
          await f.invokeRaw("crewon.project-outlines.v2.getOutline", {
            projectId,
          })
        ).statusCode,
        200,
      );
      f.state.businessAllowed = true;
      await f.f.installations.commitSelection(
        selectionRecipe(f.enabled.selection, "outline-read-disable", {
          actor,
          state: "disabled",
        }),
      );
      assert.notEqual(
        (
          await f.invokeRaw("crewon.project-outlines.v2.getOutline", {
            projectId,
          })
        ).statusCode,
        200,
      );
      assert.notEqual(
        (await f.invokeRaw("crewon.project-outlines.v2.saveCandidate", {}))
          .statusCode,
        200,
      );
      assert.equal(f.state.fallbackCalls, 0);
      assert.ok(f.authority.state.verifiedTlsConnections > 0);
      const names = await f.f.tableNames();
      assert.equal(names.includes("runs"), false);
      assert.equal(names.includes("extension_tasks"), false);
      for (const key of ["actorId", "principalId", "authorityEpoch", "lease"])
        assert.equal(JSON.stringify(page).includes(`"${key}"`), false);
    },
  );
}
