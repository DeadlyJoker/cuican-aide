import assert from "node:assert/strict";
import test from "node:test";
import {
  appendProjectBriefRevision,
  setCreativeProjectState,
  saveProjectOutlineCandidate,
  saveProjectScriptCandidate,
  selectProjectTextRevision,
  setProjectTextArtifactLocked,
  type ProjectTextArtifact,
} from "@crewon/domain";
import { pluginCommitFixture } from "./creative-project-plugin-commit.test-support.ts";
import {
  projectTextFixture,
  textActor,
  textAt,
  textDigester,
  textOwner,
} from "./project-text-store.test-support.ts";

type Fixture = Awaited<ReturnType<typeof projectTextFixture>>;
const content = {
  title: "雨中的信",
  logline: "修复师找到信",
  synopsis: "三封信揭开往事",
  episodes: [{ episodeId: "episode-1", title: "来信", summary: "画中藏着信" }],
};
const script = {
  title: "第一集",
  scenes: [
    {
      sceneId: "scene-1",
      location: "工作室",
      timeOfDay: "夜",
      action: "拿起信",
      dialogue: [{ speaker: "林予", text: "是母亲的笔迹。" }],
    },
  ],
};
const receipt = (key: string) => ({
  idempotencyKey: key,
  requestDigest: textDigester.sha256(key),
});
function candidate(
  f: Fixture,
  key: string,
  artifact: ProjectTextArtifact | null = null,
) {
  const next = saveProjectOutlineCandidate(
    {
      project: f.created.project,
      actor: textActor,
      artifact,
      artifactId: artifact?.artifactId ?? "outline-1",
      expectedArtifactRevision: artifact?.revision ?? 0,
      brief: f.created.brief,
      content,
      at: textAt,
    },
    textDigester,
  );
  return {
    kind: "save-outline" as const,
    actor: textActor,
    project: f.created.project,
    expectedArtifactRevision: artifact?.revision ?? 0,
    receipt: receipt(key),
    ...next,
  };
}
function imported(f: Fixture, key: string) {
  const next = saveProjectScriptCandidate(
    {
      project: f.created.project,
      actor: textActor,
      artifact: null,
      artifactId: "script-1",
      expectedArtifactRevision: 0,
      brief: f.created.brief,
      outline: null,
      episodeId: "episode-1",
      content: script,
      at: textAt,
    },
    textDigester,
  );
  return {
    kind: "save-script" as const,
    actor: textActor,
    project: f.created.project,
    expectedArtifactRevision: 0,
    receipt: receipt(key),
    ...next,
  };
}
const scope = (f: Fixture) => ({
  owner: textOwner(),
  projectId: f.created.project.projectId,
});
const code = (value: string) => (error: unknown) =>
  (error instanceof Error &&
    (error as Error & { code?: string }).code === value) ||
  (error instanceof Error && error.message === value);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 20_000,
  };
  test(
    `${backend} text tables require explicit migration and use the parent lifetime`,
    options,
    async (t) => {
      const f = await projectTextFixture(t, backend, false);
      await assert.rejects(f.first.text.loadOutline(scope(f)));
      await Promise.all([f.first.text.migrate(), f.second.text.migrate()]);
      assert.equal(await f.second.text.loadOutline(scope(f)), null);
      await f.first.parent.close();
      await assert.rejects(f.first.text.loadOutline(scope(f)));
      assert.equal(await f.second.text.loadOutline(scope(f)), null);
      await f.execute(
        `UPDATE ${f.prefix}project_text_schema_version SET version=2 WHERE id=1`,
      );
      await assert.rejects(
        f.second.text.migrate(),
        /project_text_schema_version_unsupported/u,
      );
    },
  );
  test(
    `${backend} concurrent first candidates CAS the logical slot; same-key retries append exactly once`,
    options,
    async (t) => {
      const f = await projectTextFixture(t, backend);
      const a = candidate(f, "writer-a"),
        b = candidate(f, "writer-b");
      // Generate the second recipe's digest through the Domain rather than patching a signed body.
      const second = saveProjectOutlineCandidate(
        {
          project: f.created.project,
          actor: textActor,
          artifact: null,
          artifactId: "outline-2",
          expectedArtifactRevision: 0,
          brief: f.created.brief,
          content,
          at: textAt,
        },
        textDigester,
      );
      const results = await Promise.allSettled([
        f.first.text.commitCandidate(a),
        f.second.text.commitCandidate({ ...b, ...second }),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failed = results.find((result) => result.status === "rejected");
      assert.ok(failed && failed.status === "rejected");
      assert.ok(code("project_text_revision_conflict")(failed.reason));
      assert.equal(await f.count("project_text_artifacts"), 1);
      assert.equal(await f.count("project_text_revisions"), 1);
      assert.equal(await f.count("project_text_mutation_receipts"), 1);
      const head = (await f.first.text.loadOutline(scope(f)))!;
      const append = candidate(f, "shared-key", head);
      const retried = await Promise.all([
        f.first.text.commitCandidate(append),
        f.second.text.commitCandidate(append),
      ]);
      assert.deepEqual(
        new Set(retried.map((result) => result.disposition)),
        new Set(["committed", "replayed"]),
      );
      assert.equal(await f.count("project_text_revisions"), 2);
      assert.equal(await f.count("project_text_mutation_receipts"), 2);
      const page = await f.first.text.listRevisions({
        ...scope(f),
        artifactId: head.artifactId,
        afterContentRevision: 0,
        limit: 1,
      });
      assert.equal(page.nextContentRevision, 1);
      assert.equal(page.revisions.length, 1);
      const last = await f.second.text.listRevisions({
        ...scope(f),
        artifactId: head.artifactId,
        afterContentRevision: page.nextContentRevision!,
        limit: 1,
      });
      assert.equal(last.nextContentRevision, null);
      assert.equal(last.revisions[0]?.contentRevision, 2);
    },
  );
  test(
    `${backend} a lost receipt replays after archival; owner, digest and current authority still gate publication`,
    options,
    async (t) => {
      const f = await projectTextFixture(t, backend),
        prepared = candidate(f, "lost-ack");
      const original = await f.first.text.commitCandidate(prepared);
      await f.projects.setProjectState(textActor, {
        projectId: f.created.project.projectId,
        expectedProjectRevision: f.created.project.revision,
        state: "archived",
        idempotencyKey: "archive",
      });
      await f.first.parent.close();
      const reopened = await f.open();
      const replay = await reopened.text.commitCandidate(prepared);
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.artifact, original.artifact);
      await assert.rejects(
        reopened.text.commitCandidate({
          ...prepared,
          receipt: receipt("different-key"),
        }),
        code("creative_project_archived"),
      );
      await assert.rejects(
        reopened.text.commitCandidate({
          ...prepared,
          receipt: {
            ...prepared.receipt,
            requestDigest: textDigester.sha256("changed-body"),
          },
        }),
        code("project_text_idempotency_conflict"),
      );
      assert.equal(
        await reopened.text.loadOutline({
          ...scope(f),
          owner: { ...textOwner(), principalId: "foreign" },
        }),
        null,
      );
      assert.equal(
        await reopened.text.loadMutationReceipt({
          actor: { ...textActor, actorId: "foreign-actor" },
          kind: prepared.kind,
          receipt: prepared.receipt,
        }),
        null,
      );
      let active = 0;
      await assert.rejects(
        reopened.text.commitCandidate(prepared, {
          authority: {
            async assertCurrent() {
              throw new Error("policy_revoked");
            },
            assertActive() {
              active++;
            },
          },
        }),
        /policy_revoked/u,
      );
      assert.equal(active, 0);
      await assert.rejects(
        reopened.text.commitCandidate({
          ...prepared,
          actor: { ...textActor, principalId: "foreign" },
        }),
        code("creative_project_owner_mismatch"),
      );
      assert.equal(await f.count("project_text_revisions"), 1);
    },
  );
  test(
    `${backend} locked selection survives appends, and stale dependencies cannot become selected`,
    options,
    async (t) => {
      const f = await projectTextFixture(t, backend),
        first = await f.first.text.commitCandidate(candidate(f, "first"));
      const chosen = selectProjectTextRevision(
        {
          project: f.created.project,
          actor: textActor,
          artifact: first.artifact,
          expectedArtifactRevision: first.artifact.revision,
          contentRevision: first.contentRevision!,
          latestBrief: f.created.brief,
          selectedOutline: null,
          at: textAt,
        },
        textDigester,
      );
      const selected = await f.first.text.commitSelection({
        actor: textActor,
        project: f.created.project,
        expectedArtifactRevision: first.artifact.revision,
        receipt: receipt("select"),
        ...chosen,
      });
      const lock = setProjectTextArtifactLocked({
        project: f.created.project,
        actor: textActor,
        artifact: selected.artifact,
        expectedArtifactRevision: selected.artifact.revision,
        locked: true,
        at: textAt,
      });
      const locked = await f.first.text.commitLock({
        actor: textActor,
        project: f.created.project,
        expectedArtifactRevision: selected.artifact.revision,
        receipt: receipt("lock"),
        ...lock,
      });
      const appended = await f.second.text.commitCandidate(
        candidate(f, "append-locked", locked.artifact),
      );
      assert.equal(appended.artifact.locked, true);
      assert.equal(appended.artifact.selectedContentRevision, 1);
      const forgedSelect = {
        ...appended.artifact,
        revision: appended.artifact.revision + 1,
        selectedContentRevision: 2,
      };
      await assert.rejects(
        f.first.text.commitSelection({
          actor: textActor,
          project: f.created.project,
          expectedArtifactRevision: appended.artifact.revision,
          receipt: receipt("replace-locked"),
          artifact: forgedSelect,
          contentRevision: appended.contentRevision!,
        }),
        code("project_text_locked"),
      );
      const importedScript = await f.first.text.commitCandidate(
        imported(f, "manual"),
      );
      const nextBrief = await f.projects.appendBrief(textActor, {
        projectId: f.created.project.projectId,
        expectedProjectRevision: f.created.project.revision,
        text: "修改结尾",
        idempotencyKey: "brief-change",
      });
      const staleScript = {
        ...importedScript.artifact,
        revision: importedScript.artifact.revision + 1,
        selectedContentRevision: 1,
      };
      await assert.rejects(
        f.first.text.commitSelection({
          actor: textActor,
          project: nextBrief.project,
          expectedArtifactRevision: importedScript.artifact.revision,
          receipt: receipt("stale-script"),
          artifact: staleScript,
          contentRevision: importedScript.contentRevision!,
        }),
        code("project_text_dependencies_stale"),
      );
      assert.equal(
        (
          await f.second.text.loadArtifact({
            ...scope(f),
            artifactId: first.artifact.artifactId,
          })
        )?.selectedContentRevision,
        1,
      );
      const page = await f.first.text.listArtifacts({
        ...scope(f),
        afterArtifactId: null,
        limit: 1,
      });
      assert.equal(page.artifacts.length, 1);
      assert.ok(page.nextArtifactId);
      assert.equal(
        (
          await f.first.text.listArtifacts({
            ...scope(f),
            afterArtifactId: page.nextArtifactId,
            limit: 1,
          })
        ).nextArtifactId,
        null,
      );
    },
  );
  test(
    `${backend} stored history and receipts are immutable; corrupt head metadata fails closed`,
    options,
    async (t) => {
      const f = await projectTextFixture(t, backend);
      await f.first.text.commitCandidate(candidate(f, "one"));
      await assert.rejects(
        f.execute(
          `UPDATE ${f.prefix}project_text_revisions SET content_digest=content_digest`,
        ),
        /project_text_history_immutable/u,
      );
      await assert.rejects(
        f.execute(`DELETE FROM ${f.prefix}project_text_mutation_receipts`),
        /project_text_history_immutable/u,
      );
      await assert.rejects(
        f.execute(
          `UPDATE ${f.prefix}project_text_artifacts SET artifact_id='changed'`,
        ),
        /project_text_identity_immutable/u,
      );
      const jsonExpr =
        backend === "sqlite"
          ? "json_set(record_json,'$.selectedContentRevision',1)"
          : "jsonb_set(record_json,'{selectedContentRevision}','1'::jsonb)";
      await assert.rejects(
        f.execute(
          `UPDATE ${f.prefix}project_text_artifacts SET record_json=${jsonExpr}`,
        ),
      );
      const corrupt =
        backend === "sqlite"
          ? "json_set(record_json,'$.unknown',1)"
          : "jsonb_set(record_json,'{unknown}','1'::jsonb)";
      await f.execute(
        `UPDATE ${f.prefix}project_text_artifacts SET record_json=${corrupt}`,
      );
      await assert.rejects(
        f.first.text.loadOutline(scope(f)),
        /fields_invalid/u,
      );
    },
  );
  test(
    `${backend} receipt insertion failure rolls back the candidate and head together`,
    options,
    async (t) => {
      const f = await projectTextFixture(t, backend);
      if (backend === "sqlite")
        await f.execute(
          "CREATE TRIGGER text_receipt_fail BEFORE INSERT ON project_text_mutation_receipts BEGIN SELECT RAISE(ABORT,'owned_receipt_failure'); END",
        );
      else
        await f.execute(
          `CREATE FUNCTION ${f.prefix}text_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned_receipt_failure'; END; $$; CREATE TRIGGER text_receipt_fail BEFORE INSERT ON ${f.prefix}project_text_mutation_receipts FOR EACH ROW EXECUTE FUNCTION ${f.prefix}text_receipt_fail()`,
        );
      await assert.rejects(
        f.first.text.commitCandidate(candidate(f, "rollback")),
        /owned_receipt_failure/u,
      );
      for (const table of [
        "project_text_artifacts",
        "project_text_revisions",
        "project_text_mutation_receipts",
      ])
        assert.equal(await f.count(table), 0);
    },
  );
  test(
    `${backend} forged content, missing dependencies, accessors and the old UI transaction authority never write`,
    options,
    async (t) => {
      const f = await projectTextFixture(t, backend),
        prepared = candidate(f, "invalid");
      await assert.rejects(
        f.first.text.commitCandidate({
          ...prepared,
          artifact: {
            ...prepared.artifact,
            updatedAt: "2026-10-05T01:00:00.000Z",
          },
        }),
        /project_text_store_recipe_invalid/u,
      );
      const unstored = appendProjectBriefRevision(
        {
          project: f.created.project,
          actor: textActor,
          expectedProjectRevision: f.created.project.revision,
          text: "尚未保存的真实形状",
          at: textAt,
        },
        textDigester,
      );
      const missing = saveProjectOutlineCandidate(
        {
          project: f.created.project,
          actor: textActor,
          artifact: null,
          artifactId: "outline-1",
          expectedArtifactRevision: 0,
          brief: unstored.brief,
          content,
          at: textAt,
        },
        textDigester,
      );
      await assert.rejects(
        f.first.text.commitCandidate({ ...prepared, ...missing }),
        code("creative_project_brief_not_found"),
      );
      assert.equal(prepared.contentRevision.kind, "outline");
      if (prepared.contentRevision.kind !== "outline") assert.fail();
      const missingOutline = saveProjectScriptCandidate(
        {
          project: f.created.project,
          actor: textActor,
          artifact: null,
          artifactId: "script-1",
          expectedArtifactRevision: 0,
          brief: f.created.brief,
          outline: prepared.contentRevision,
          episodeId: "episode-1",
          content: script,
          at: textAt,
        },
        textDigester,
      );
      await assert.rejects(
        f.first.text.commitCandidate({
          ...prepared,
          kind: "save-script",
          ...missingOutline,
        }),
        code("project_text_revision_not_found"),
      );
      let getters = 0;
      const accessor = Object.defineProperty({ ...prepared }, "kind", {
        enumerable: true,
        get() {
          getters++;
          return "save-outline";
        },
      });
      await assert.rejects(
        f.first.text.commitCandidate(accessor),
        /json_invalid/u,
      );
      assert.equal(getters, 0);
      const legacy = await pluginCommitFixture(t, backend);
      await assert.rejects(
        f.first.text.commitCandidate(prepared, {
          authority: legacy.grant().authority,
        }),
        code("project_text_transaction_authority_unsupported"),
      );
      for (const table of [
        "project_text_artifacts",
        "project_text_revisions",
        "project_text_mutation_receipts",
      ])
        assert.equal(await f.count(table), 0);
    },
  );
}

test(
  "postgres queued text write observes real project archival under the shared lock with maxPoolSize 1",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 20_000 },
  async (t) => {
    const f = await projectTextFixture(t, "postgres"),
      entered = deferred(),
      release = deferred();
    t.after(() => release.resolve());
    let calls = 0;
    const archivedProject = setCreativeProjectState({
      project: f.created.project,
      actor: textActor,
      expectedProjectRevision: f.created.project.revision,
      state: "archived",
      at: textAt,
    });
    const archival = f.first.projects.commitProjectMetadata(
      {
        actor: textActor,
        kind: "set-project-state",
        project: archivedProject,
        expectedProjectRevision: f.created.project.revision,
        receipt: receipt("actual-archival"),
      },
      {
        authority: {
          async assertCurrent() {
            if (++calls === 2) {
              entered.resolve();
              await release.promise;
            }
          },
          assertActive() {},
        },
      },
    );
    await entered.promise;
    let settled = false;
    const pending = f.second.text.commitCandidate(candidate(f, "queued"));
    const observed = pending.then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    // pg_locks proves a genuine waiter, rather than a synthetic delay inside text storage.
    const deadline = Date.now() + 2000;
    let waiting = false;
    while (Date.now() < deadline && !waiting) {
      waiting =
        Number(
          (
            await f.sql(
              "SELECT COUNT(*) AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
            )
          )[0]?.n,
        ) > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(waiting, true);
    assert.equal(settled, false);
    assert.equal(await f.count("project_text_artifacts"), 0);
    const rejected = assert.rejects(
      observed,
      code("creative_project_archived"),
    );
    release.resolve();
    await archival;
    await rejected;
    assert.equal(await f.count("project_text_revisions"), 0);
    assert.equal(await f.count("project_text_mutation_receipts"), 0);
  },
);
test(
  "postgres final policy withdrawal rolls back all SQL; a successful retry still has one receipt",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 20_000 },
  async (t) => {
    const f = await projectTextFixture(t, "postgres"),
      prepared = candidate(f, "policy-cas");
    let calls = 0;
    await assert.rejects(
      f.first.text.commitCandidate(prepared, {
        authority: {
          async assertCurrent() {
            if (++calls === 2) throw new Error("policy_revoked_before_commit");
          },
          assertActive() {},
        },
      }),
      /policy_revoked_before_commit/u,
    );
    assert.equal(calls, 2);
    for (const table of [
      "project_text_artifacts",
      "project_text_revisions",
      "project_text_mutation_receipts",
    ])
      assert.equal(await f.count(table), 0);
    const committed = await f.second.text.commitCandidate(prepared);
    assert.equal(committed.disposition, "committed");
    assert.equal(
      (await f.first.text.commitCandidate(prepared)).disposition,
      "replayed",
    );
    assert.equal(await f.count("project_text_mutation_receipts"), 1);
  },
);
