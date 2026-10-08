import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parseProjectOutlineEditRequest,
  parseProjectOutlineEditResult,
  type ProjectOutlineEditResult,
} from "@crewon/contracts/project-outline-edits";
import type { ProjectFoundationMutationResponse } from "@crewon/contracts/project-foundation";
import { foundationUiHttpFixture } from "./project-foundation-plugin-ui.integration.test-support.ts";
import { importParameters } from "./project-foundation-import.test-support.ts";
import { optionsFor } from "../../../packages/store/src/creative-project-plugin-commit.test-support.ts";
import { outlineDocument } from "../../../packages/store/src/project-structured-outline.test-support.ts";

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: installed UI saves and adopts structured outlines through HTTP, retries exactly and rejects stale or withdrawn writes`,
    { ...optionsFor(backend), timeout: 30_000 },
    async (t) => {
      const f = await foundationUiHttpFixture(t, backend, {
        uploads: true,
        outlines: true,
        outlineEdits: true,
      });
      const document = outlineDocument();
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
        idempotencyKey: "outline-edit-source",
      });
      const written = await f.writePart(
        {
          uploadId: begun.upload.uploadId,
          partIndex: 0,
          rawDigest: digest(bytes),
        },
        bytes,
      );
      await f.invokeUpload("prepare", {
        uploadId: begun.upload.uploadId,
        expectedRevision: written.upload.revision,
      });
      const created = (await f.invoke("createProject", {
        title: document.title,
        briefText: "完整保存改编成果。",
        origin: "novel",
        parameters: {
          ...importParameters("novel"),
          genre: document.params.genre,
          episodeCount: document.params.episodes,
          episodeDurationSeconds: {
            minimum: document.params.minutesPerEpisode * 60,
            maximum: document.params.minutesPerEpisode * 60,
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
        idempotencyKey: "outline-edit-project",
      })) as ProjectFoundationMutationResponse;
      const projectId = created.project.projectId;
      const proposal = (await f.invoke("saveProposal", {
        projectId,
        expectedFoundationRevision: created.foundation.revision,
        expectedProposalRevision: 0,
        kind: "novel-adaptation",
        text: "以渡口冲突为核心，依照原文制作分集。",
        idempotencyKey: "outline-edit-proposal",
      })) as ProjectFoundationMutationResponse;
      await f.invoke("confirmProposal", {
        projectId,
        expectedFoundationRevision: created.foundation.revision,
        proposalRevision: proposal.proposal!.revision,
        proposalDigest: proposal.proposal!.contentDigest,
        idempotencyKey: "outline-edit-confirm",
      });
      const invoke = async (
        action: string,
        input: unknown,
      ): Promise<ProjectOutlineEditResult> => {
        const request = parseProjectOutlineEditRequest({ action, input });
        const response = await f.invokeRaw(action, input);
        assert.equal(response.statusCode, 200, response.body);
        return parseProjectOutlineEditResult(request, response.json().output);
      };
      const saveAction = "crewon.project-outline-edits.v1.saveCandidate";
      const original = {
        projectId,
        expectedArtifactRevision: 0,
        briefRevision: created.brief!.briefRevision,
        base: null,
        change: { kind: "initialize", document },
        idempotencyKey: "outline-edit-save",
      };
      const saved = await invoke(saveAction, original);
      assert.equal(saved.disposition, "committed");
      assert.equal(saved.artifactRevision, 1);
      const replayed = await invoke(saveAction, original);
      assert.deepEqual(replayed, { ...saved, disposition: "replayed" });
      const patch = {
        projectId,
        expectedArtifactRevision: saved.artifactRevision,
        briefRevision: created.brief!.briefRevision,
        base: {
          contentRevision: saved.contentRevision,
          contentDigest: saved.contentDigest,
        },
        change: {
          kind: "overview",
          value: {
            title: "渡口 · 修订",
            logline: document.logline,
            synopsis: document.synopsis,
            source: document.source,
            lang: document.lang,
            params: document.params,
          },
        },
        idempotencyKey: "outline-edit-patch",
      };
      const revised = await invoke(saveAction, patch);
      assert.equal(revised.contentRevision, saved.contentRevision + 1);
      const stale = await f.invokeRaw(saveAction, {
        ...patch,
        idempotencyKey: "outline-edit-stale",
      });
      assert.equal(stale.statusCode, 409, stale.body);
      const adopted = await invoke(
        "crewon.project-outline-edits.v1.selectRevision",
        {
          projectId,
          artifactId: saved.artifactId,
          expectedArtifactRevision: revised.artifactRevision,
          contentRevision: revised.contentRevision,
          idempotencyKey: "outline-edit-adopt",
        },
      );
      assert.equal(adopted.artifactRevision, revised.artifactRevision + 1);
      const read = await f.invokeRaw("crewon.project-outlines.v2.getSection", {
        projectId,
        artifactId: saved.artifactId,
        contentRevision: revised.contentRevision,
        contentDigest: revised.contentDigest,
        section: "overview",
        afterIndex: 0,
        limit: 10,
      });
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(read.json().output.items[0].title, "渡口 · 修订");
      f.state.businessAllowed = false;
      const denied = await f.invokeRaw(saveAction, {
        ...patch,
        expectedArtifactRevision: adopted.artifactRevision,
        base: {
          contentRevision: revised.contentRevision,
          contentDigest: revised.contentDigest,
        },
        idempotencyKey: "outline-edit-denied",
      });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(f.state.fallbackCalls, 0);
    },
  );
}
