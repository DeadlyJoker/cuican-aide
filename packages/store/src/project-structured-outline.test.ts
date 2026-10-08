import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationError,
  ProjectTextApplicationService,
} from "@crewon/application";
import {
  parseProjectTextArtifact,
  parseProjectStructuredOutlineRevision,
  parseProjectTextArtifactRevision,
  parseProjectOutlineDocument,
  evaluateProjectOutlineQuality,
  saveProjectOutlineCandidate,
  selectProjectTextRevision,
  setProjectTextArtifactLocked,
  setCreativeProjectState,
  projectOutlineInputBinding,
  type ProjectStructuredOutlineRevision,
} from "@crewon/domain";
import {
  structuredOutlineFixture,
  longOutlineDocument,
  candidate,
  selection,
  actor,
  owner,
  digester,
  receipt,
  time,
  code,
  proposalRecipe,
  confirmationRecipe,
} from "./project-structured-outline.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30_000,
  };
  test(
    `${backend} v2 appends to the original adopted outline, preserves v1 history and replays after cold reopen`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const legacy = saveProjectOutlineCandidate(
        {
          project: f.created.project,
          actor,
          artifact: null,
          artifactId: "outline-1",
          expectedArtifactRevision: 0,
          brief: f.created.brief!,
          content: {
            title: "旧大纲",
            logline: "原有故事",
            synopsis: "原有梗概",
            episodes: [
              { episodeId: "episode-1", title: "来信", summary: "旧摘要" },
            ],
          },
          at: time(3),
        },
        digester,
      );
      await f.first.text.commitCandidate({
        ...legacy,
        actor,
        kind: "save-outline",
        receipt: receipt("legacy-save"),
        project: f.created.project,
        expectedArtifactRevision: 0,
      });
      const adopted = selectProjectTextRevision(
        {
          project: f.created.project,
          actor,
          artifact: legacy.artifact,
          expectedArtifactRevision: legacy.artifact.revision,
          contentRevision: legacy.contentRevision,
          latestBrief: f.created.brief!,
          selectedOutline: null,
          at: time(3),
        },
        digester,
      );
      await f.first.text.commitSelection({
        ...adopted,
        actor,
        receipt: receipt("legacy-select"),
        project: f.created.project,
        expectedArtifactRevision: legacy.artifact.revision,
      });
      const command = candidate(f, "new-candidate", adopted.artifact);
      const saved =
        await f.first.text.commitStructuredOutlineCandidate(command);
      assert.equal(saved.artifact.artifactId, legacy.artifact.artifactId);
      assert.equal(saved.artifact.latestContentRevision, 2);
      assert.equal(saved.artifact.selectedContentRevision, 1);
      assert.deepEqual(
        await f.first.text.loadRevision({
          ...f.scope,
          artifactId: "outline-1",
          contentRevision: 1,
        }),
        legacy.contentRevision,
      );
      const page = await f.first.text.listStructuredRevisions({
        ...f.scope,
        artifactId: "outline-1",
        afterContentRevision: 0,
        limit: 2,
      });
      assert.deepEqual(
        page.revisions.map((item) => item.schemaVersion),
        ["crewon.project-text-revision.v1", "crewon.project-text-revision.v2"],
      );
      assert.deepEqual(page.revisions[1], command.contentRevision);
      const selected = await f.first.text.commitStructuredOutlineSelection(
        selection(f, "new-select", saved.artifact, command.contentRevision),
      );
      assert.equal(selected.artifact.selectedContentRevision, 2);
      const legacyService = new ProjectTextApplicationService({
        store: f.first.text,
        projects: f.first.projects,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => time(5) },
        ids: { nextId: () => "unused-artifact" },
        digester,
      });
      await assert.rejects(
        legacyService.getOutline(actor, {
          projectId: f.created.project.projectId,
        }),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.category === "conflict" &&
          error.code === "project_text_protocol_upgrade_required",
      );
      const locked = setProjectTextArtifactLocked({
        project: f.created.project,
        actor,
        artifact: selected.artifact,
        expectedArtifactRevision: selected.artifact.revision,
        locked: true,
        at: time(5),
      });
      await f.first.text.commitLock({
        ...locked,
        actor,
        receipt: receipt("lock-v2"),
        project: f.created.project,
        expectedArtifactRevision: selected.artifact.revision,
      });
      const appended = await f.first.text.commitStructuredOutlineCandidate(
        candidate(f, "locked-candidate", locked.artifact),
      );
      assert.equal(appended.artifact.selectedContentRevision, 2);
      assert.equal(appended.artifact.locked, true);
      await f.first.parent.close();
      const cold = await f.open();
      const replay = await cold.text.commitStructuredOutlineCandidate(command);
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.contentRevision, command.contentRevision);
      assert.equal(await f.count("project_text_revisions"), 3);
      assert.deepEqual(
        await cold.text.loadStructuredRevision({
          ...f.scope,
          artifactId: "outline-1",
          contentRevision: 2,
        }),
        command.contentRevision,
      );
      await assert.rejects(
        cold.text.loadRevision({
          ...f.scope,
          artifactId: "outline-1",
          contentRevision: 2,
        }),
        code("project_text_protocol_upgrade_required"),
      );
      await assert.rejects(
        cold.text.loadMutationReceipt({
          actor,
          kind: "save-outline",
          receipt: command.receipt,
        }),
        code("project_text_protocol_upgrade_required"),
      );
      const changed = candidate(
        f,
        "new-candidate",
        adopted.artifact,
        parseProjectOutlineDocument({ ...f.document, title: "不同候选" }),
      );
      await assert.rejects(
        cold.text.commitStructuredOutlineCandidate({
          ...changed,
          receipt: {
            ...changed.receipt,
            requestDigest: digester.sha256("different-command"),
          },
        }),
        code("project_text_idempotency_conflict"),
      );
    },
  );
  test(
    `${backend} v1 cannot replace or adopt after a v2 candidate exists`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const command = candidate(f, "v2-first");
      const saved =
        await f.first.text.commitStructuredOutlineCandidate(command);
      const legacy = saveProjectOutlineCandidate(
        {
          project: f.created.project,
          actor,
          artifact: saved.artifact,
          artifactId: saved.artifact.artifactId,
          expectedArtifactRevision: saved.artifact.revision,
          brief: f.created.brief!,
          content: {
            title: "旧编辑器",
            logline: "内容",
            synopsis: "梗概",
            episodes: [
              { episodeId: "episode-1", title: "第一集", summary: "摘要" },
            ],
          },
          at: time(4),
        },
        digester,
      );
      await assert.rejects(
        f.first.text.commitCandidate({
          ...legacy,
          actor,
          kind: "save-outline",
          receipt: receipt("v1-write"),
          project: f.created.project,
          expectedArtifactRevision: saved.artifact.revision,
        }),
        code("project_text_protocol_upgrade_required"),
      );
      await assert.rejects(
        f.first.text.listRevisions({
          ...f.scope,
          artifactId: saved.artifact.artifactId,
          afterContentRevision: 0,
          limit: 2,
        }),
        code("project_text_protocol_upgrade_required"),
      );
      assert.equal(await f.count("project_text_revisions"), 1);
      assert.deepEqual(await f.first.text.loadOutline(f.scope), saved.artifact);
    },
  );
  test(
    `${backend} incomplete quality can be saved as a draft but adoption reevaluates actual persisted content`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const episodes = f.document.episodes.map((episode, index) =>
        index === 0 ? { ...episode, hook: "" } : episode,
      );
      const command = candidate(
        f,
        "bad-hook",
        null,
        parseProjectOutlineDocument({ ...f.document, episodes }),
      );
      assert.equal(
        evaluateProjectOutlineQuality(command.contentRevision.content, "full")
          .passed,
        false,
      );
      const saved =
        await f.first.text.commitStructuredOutlineCandidate(command);
      const artifact = parseProjectTextArtifact({
        ...saved.artifact,
        revision: saved.artifact.revision + 1,
        selectedContentRevision: 1,
        updatedAt: time(4),
      });
      await assert.rejects(
        f.first.text.commitStructuredOutlineSelection({
          actor,
          receipt: receipt("adopt-incomplete"),
          project: f.created.project,
          expectedArtifactRevision: saved.artifact.revision,
          artifact,
          contentRevision: command.contentRevision,
        }),
        code("project_outline_quality_failed"),
      );
      assert.deepEqual(await f.first.text.loadOutline(f.scope), saved.artifact);
      assert.equal(await f.count("project_text_mutation_receipts"), 1);
    },
  );
  test(
    `${backend} adoption checks the actual original book, including quotes spanning Unicode chunk boundaries`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const command = candidate(f, "real-quotes");
      const saved =
        await f.first.text.commitStructuredOutlineCandidate(command);
      assert.equal(
        evaluateProjectOutlineQuality(f.document, "full").passed,
        true,
      );
      const selected = await f.first.text.commitStructuredOutlineSelection(
        selection(f, "real-adopt", saved.artifact, command.contentRevision),
      );
      assert.equal(selected.artifact.selectedContentRevision, 1);
      const content = parseProjectOutlineDocument({
        ...f.document,
        adaptation: {
          ...f.document.adaptation,
          keep: f.document.adaptation.keep.map((item, index) =>
            index === 0
              ? { ...item, evidence: "这段句子不在这本原著中。" }
              : item,
          ),
        },
      });
      assert.equal(evaluateProjectOutlineQuality(content, "full").passed, true);
      const falseCommand = candidate(
        f,
        "wrong-quote",
        selected.artifact,
        content,
      );
      const falseSaved =
        await f.first.text.commitStructuredOutlineCandidate(falseCommand);
      await assert.rejects(
        f.first.text.commitStructuredOutlineSelection(
          selection(
            f,
            "false-adopt",
            falseSaved.artifact,
            falseCommand.contentRevision,
          ),
        ),
        code("project_outline_source_evidence_mismatch"),
      );
      assert.deepEqual(
        await f.first.text.loadOutline(f.scope),
        falseSaved.artifact,
      );
      assert.equal(falseSaved.artifact.selectedContentRevision, 1);
      assert.equal(await f.count("project_text_mutation_receipts"), 3);
      assert.equal(await f.count("project_sources"), 1);
    },
  );
  test(
    `${backend} current inputs, actual parameters and a newly confirmed plan fence stale writes atomically`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const actualBinding = projectOutlineInputBinding(
        f.confirmed.foundation,
        digester,
      );
      const forged = candidate(f, "forged-inputs", null, f.document, {
        ...actualBinding,
        source: {
          ...actualBinding.source,
          digest: digester.sha256("wrong-original"),
        },
      });
      await assert.rejects(
        f.first.text.commitStructuredOutlineCandidate(forged),
        code("project_outline_inputs_stale"),
      );
      const altered = candidate(
        f,
        "altered-parameters",
        null,
        parseProjectOutlineDocument({
          ...f.document,
          params: { ...f.document.params, genre: "更改题材" },
        }),
      );
      await assert.rejects(
        f.first.text.commitStructuredOutlineCandidate(altered),
        code("project_outline_parameters_mismatch"),
      );
      const prepared = candidate(f, "stale-candidate");
      const proposal = await f.foundations.commitProposal(
        proposalRecipe(
          f.created.project,
          f.confirmed.foundation,
          "new-plan",
          f.proposal,
          3,
        ),
      );
      await f.foundations.commitFoundationChange(
        confirmationRecipe(
          f.created.project,
          f.confirmed.foundation,
          proposal.proposal!,
          "confirm-new-plan",
          4,
        ),
      );
      await assert.rejects(
        f.first.text.commitStructuredOutlineCandidate(prepared),
        code("project_outline_inputs_stale"),
      );
      assert.equal(await f.count("project_text_artifacts"), 0);
      assert.equal(await f.count("project_text_revisions"), 0);
      assert.equal(await f.count("project_text_mutation_receipts"), 0);
    },
  );
  test(
    `${backend} concurrent candidates share the original head CAS and actor-scoped receipts`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const commands = [candidate(f, "writer-a"), candidate(f, "writer-b")];
      const outcomes = await Promise.allSettled([
        f.first.text.commitStructuredOutlineCandidate(commands[0]!),
        f.second.text.commitStructuredOutlineCandidate(commands[1]!),
      ]);
      assert.equal(
        outcomes.filter((item) => item.status === "fulfilled").length,
        1,
      );
      const rejected = outcomes.find((item) => item.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.ok(code("project_text_revision_conflict")(rejected.reason));
      assert.equal(await f.count("project_text_artifacts"), 1);
      assert.equal(await f.count("project_text_revisions"), 1);
      assert.equal(await f.count("project_text_mutation_receipts"), 1);
    },
  );
  test(
    `${backend} a 120-episode revision larger than v1's 64KiB is verified, stored and paged without widening v1`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(
        t,
        backend,
        longOutlineDocument(),
      );
      assert.equal(
        evaluateProjectOutlineQuality(f.document, "full").passed,
        true,
      );
      const command = candidate(f, "long-outline");
      assert.ok(
        Buffer.byteLength(JSON.stringify(command.contentRevision)) > 65_536,
      );
      const saved =
        await f.first.text.commitStructuredOutlineCandidate(command);
      const loaded = await f.second.text.loadStructuredRevision({
        ...f.scope,
        artifactId: saved.artifact.artifactId,
        contentRevision: 1,
      });
      assert.deepEqual(loaded, command.contentRevision);
      assert.deepEqual(
        parseProjectStructuredOutlineRevision(loaded, digester),
        loaded,
      );
      assert.throws(() => parseProjectTextArtifactRevision(loaded, digester));
      const adopted = await f.first.text.commitStructuredOutlineSelection(
        selection(f, "long-adopt", saved.artifact, command.contentRevision),
      );
      assert.equal(adopted.artifact.selectedContentRevision, 1);
      const page = await f.first.text.listStructuredRevisions({
        ...f.scope,
        artifactId: saved.artifact.artifactId,
        afterContentRevision: 0,
        limit: 1,
      });
      assert.equal(page.revisions.length, 1);
      assert.equal(page.nextContentRevision, null);
    },
  );
  test(
    `${backend} withdrawn commit authority rolls back the head, revision and receipt`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      let checks = 0;
      await assert.rejects(
        f.first.text.commitStructuredOutlineCandidate(
          candidate(f, "withdrawn"),
          {
            authority: {
              assertCurrent: async () => {},
              assertActive: () => {
                if (++checks >= 3) throw new Error("authority-withdrawn");
              },
            },
          },
        ),
        /authority-withdrawn/u,
      );
      assert.equal(await f.count("project_text_artifacts"), 0);
      assert.equal(await f.count("project_text_revisions"), 0);
      assert.equal(await f.count("project_text_mutation_receipts"), 0);
      const saved = await f.first.text.commitStructuredOutlineCandidate(
        candidate(f, "withdrawn"),
      );
      assert.equal(saved.disposition, "committed");
      assert.equal(await f.count("project_text_mutation_receipts"), 1);
    },
  );
  test(
    `${backend} archival and foreign owner reads retain the original project boundary`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const command = candidate(f, "archive-race");
      const archived = setCreativeProjectState({
        project: f.created.project,
        actor,
        expectedProjectRevision: f.created.project.revision,
        state: "archived",
        at: time(3),
      });
      await f.first.projects.commitProjectMetadata({
        kind: "set-project-state",
        actor,
        receipt: receipt("archive"),
        expectedProjectRevision: f.created.project.revision,
        project: archived,
      });
      await assert.rejects(
        f.first.text.commitStructuredOutlineCandidate(command),
        code("creative_project_archived"),
      );
      assert.equal(await f.count("project_text_revisions"), 0);
      assert.equal(
        await f.first.text.loadStructuredRevision({
          owner: { ...owner(), principalId: "foreign-owner" },
          projectId: f.created.project.projectId,
          artifactId: "outline-1",
          contentRevision: 1,
        }),
        null,
      );
    },
  );
}
