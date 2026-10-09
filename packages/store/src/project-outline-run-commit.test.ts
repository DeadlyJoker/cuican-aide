import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  captureProjectOutlineRunCommitTransaction,
  projectStructuredOutlineCommandReceipt,
} from "@crewon/application";
import {
  changeProjectOutlineDocument,
  saveProjectStructuredOutlineCandidate,
  saveProjectOutlineCandidate,
  selectProjectTextRevision,
} from "@crewon/domain";
import {
  outlineToolFixture,
  outlineHasCause,
} from "./project-outline-run-commit.test-support.ts";
import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30_000,
  };
  test(
    `${backend}: original Tool appends v2 candidate to original tables and cold replay does not adopt or duplicate`,
    options,
    async (t) => {
      const f = await outlineToolFixture(t, backend),
        op = await f.prepare();
      const saved = await f
        .application()
        .saveCandidate(f.actor, op.command, op.options);
      assert.equal(saved.disposition, "committed");
      assert.equal(
        saved.contentRevision?.schemaVersion,
        "crewon.project-text-revision.v2",
      );
      assert.equal(saved.artifact.latestContentRevision, 1);
      assert.equal(saved.artifact.selectedContentRevision, null);
      assert.equal(saved.artifact.locked, false);
      assert.equal(await f.count("project_text_revisions"), 1);
      assert.equal(await f.count("run_snapshots"), 1);
      await f.foundation.invalidate();
      const cold = await f.open();
      const replay = await f
        .application(cold.parent)
        .saveCandidate(f.actor, op.command, op.options);
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual({ ...replay, disposition: "committed" }, saved);
      assert.equal(await f.count("project_text_revisions"), 1);
      assert.equal(await f.count("project_text_mutation_receipts"), 1);
    },
  );

  test(
    `${backend}: exact base and stable character IDs share the manual document change semantics`,
    options,
    async (t) => {
      const f = await outlineToolFixture(t, backend),
        first = await f.prepare();
      const saved = await f
        .application()
        .saveCandidate(f.actor, first.command, first.options);
      assert.ok(saved.contentRevision);
      assert.equal(
        saved.contentRevision.schemaVersion,
        "crewon.project-text-revision.v2",
      );
      if (
        saved.contentRevision.schemaVersion !==
        "crewon.project-text-revision.v2"
      )
        assert.fail();
      const character = saved.contentRevision.content.characters[0]!;
      const op = await f.prepare({
        expectedArtifactRevision: saved.artifact.revision,
        base: {
          contentRevision: saved.contentRevision.contentRevision,
          contentDigest: saved.contentRevision.contentDigest,
        },
        change: {
          kind: "upsert",
          collection: "characters",
          items: [{ ...character, name: "手动与 Agent 共用人物" }],
          removeIds: [],
        },
      });
      const next = await f
        .application()
        .saveCandidate(f.actor, op.command, op.options);
      assert.equal(next.artifact.latestContentRevision, 2);
      assert.equal(next.artifact.selectedContentRevision, null);
      assert.ok(
        next.contentRevision?.schemaVersion ===
          "crewon.project-text-revision.v2",
      );
      assert.equal(
        next.contentRevision.content.characters[0]!.id,
        character.id,
      );
      assert.equal(
        next.contentRevision.content.characters[0]!.name,
        "手动与 Agent 共用人物",
      );
      assert.deepEqual(
        next.contentRevision.content.episodes,
        saved.contentRevision.content.episodes,
      );
      assert.deepEqual(
        await f.store.loadStructuredRevision({
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: f.reference.projectId,
          artifactId: saved.artifact.artifactId,
          contentRevision: 1,
        }),
        saved.contentRevision,
      );
    },
  );

  test(
    `${backend}: Agent v2 candidate preserves the user's adopted v1 and original history`,
    options,
    async (t) => {
      const f = await outlineToolFixture(t, backend);
      const owner = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        principalId: f.actor.principalId,
      };
      const project = (await f.metadata.loadProject({
        owner,
        projectId: f.reference.projectId,
      }))!;
      const legacy = saveProjectOutlineCandidate(
        {
          project,
          actor: f.actor,
          artifact: null,
          artifactId: "original-adopted-outline",
          expectedArtifactRevision: 0,
          brief: f.brief,
          content: {
            title: "用户已采用大纲",
            logline: "原主线",
            synopsis: "保留原内容",
            episodes: [
              {
                episodeId: "original-episode",
                title: "原第一集",
                summary: "原摘要",
              },
            ],
          },
          at: new Date().toISOString(),
        },
        digester,
      );
      await f.store.commitCandidate({
        ...legacy,
        project,
        actor: f.actor,
        kind: "save-outline",
        expectedArtifactRevision: 0,
        receipt: {
          idempotencyKey: "manual-original",
          requestDigest: digester.sha256("manual-original"),
        },
      });
      const adopted = selectProjectTextRevision(
        {
          project,
          actor: f.actor,
          artifact: legacy.artifact,
          expectedArtifactRevision: legacy.artifact.revision,
          contentRevision: legacy.contentRevision,
          latestBrief: f.brief,
          selectedOutline: null,
          at: new Date().toISOString(),
        },
        digester,
      );
      await f.store.commitSelection({
        ...adopted,
        project,
        actor: f.actor,
        expectedArtifactRevision: legacy.artifact.revision,
        receipt: {
          idempotencyKey: "manual-adopt",
          requestDigest: digester.sha256("manual-adopt"),
        },
      });
      const op = await f.prepare({
        expectedArtifactRevision: adopted.artifact.revision,
        base: null,
        change: { kind: "initialize", document: f.document },
      });
      const next = await f
        .application()
        .saveCandidate(f.actor, op.command, op.options);
      assert.equal(next.artifact.artifactId, legacy.artifact.artifactId);
      assert.equal(next.artifact.latestContentRevision, 2);
      assert.equal(next.artifact.selectedContentRevision, 1);
      assert.deepEqual(
        await f.store.loadRevision({
          owner,
          projectId: project.projectId,
          artifactId: legacy.artifact.artifactId,
          contentRevision: 1,
        }),
        legacy.contentRevision,
      );
    },
  );

  test(
    `${backend}: original unknown receipt with a new real lease replays only its saved candidate`,
    options,
    async (t) => {
      const f = await outlineToolFixture(t, backend),
        op = await f.prepare();
      const first = await f
        .application()
        .saveCandidate(f.actor, op.command, op.options);
      const unknown = await f.parent.transitionToolExecution({
        tenantId: f.actor.tenantId,
        runId: f.locator.runId,
        receiptId: op.receipt.receiptId,
        lease: f.lease,
        expectedRevision: op.receipt.revision,
        transition: {
          kind: "unknownOutcome",
          providerReceiptId: null,
          occurredAt: new Date().toISOString(),
        },
      });
      await f.parent.retryWorkItem({
        ...f.lease,
        retryAfterMs: 0,
        reasonCode: "outline-native-owner-retired",
      });
      await f.parent.close();
      const next = (await f.open()).parent;
      const claim = await next.claimNextWorkItem({
        ownerId: "outline-next-worker",
        leaseId: "outline-next-lease",
        leaseDurationMs: 300000,
      });
      assert.ok(claim);
      assert.ok(claim.lease.epoch > op.transaction.claim.lease.epoch);
      const lease = {
        workItemId: claim.workItem.workItemId,
        ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId,
        leaseEpoch: claim.lease.epoch,
      };
      await next.beginRunAttempt({
        tenantId: f.actor.tenantId,
        runId: f.locator.runId,
        lease,
        stepId: unknown.stepId,
        attemptId: "outline-next-attempt",
        kind: "tool",
        startedAt: new Date().toISOString(),
      });
      const run = await next.loadRun(f.locator);
      assert.ok(run);
      await assert.rejects(
        f.application(next).saveCandidate(f.actor, op.command, op.options),
      );
      const transaction = captureProjectOutlineRunCommitTransaction({
        ...op.transaction,
        run,
        receipt: unknown,
        claim,
      });
      const replay = await f
        .application(next)
        .saveCandidate(f.actor, op.command, {
          authority: {
            ...op.options.authority!,
            outlineRunTransaction: transaction,
          },
        });
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual({ ...replay, disposition: "committed" }, first);
      assert.equal(await f.count("project_text_revisions"), 1);
    },
  );

  test(
    `${backend}: actor, candidate input and adoption cannot be substituted at application or direct Store boundary`,
    options,
    async (t) => {
      const f = await outlineToolFixture(t, backend),
        op = await f.prepare();
      const saved = await f
        .application()
        .saveCandidate(f.actor, op.command, op.options);
      assert.ok(
        saved.contentRevision?.schemaVersion ===
          "crewon.project-text-revision.v2",
      );
      await assert.rejects(
        f.application().selectRevision(
          f.actor,
          {
            projectId: f.reference.projectId,
            expectedArtifactRevision: saved.artifact.revision,
            artifactId: saved.artifact.artifactId,
            contentRevision: 1,
            idempotencyKey: op.command.idempotencyKey,
          },
          op.options,
        ),
        outlineHasCause("project_outline_run_commit_authority_invalid"),
      );
      await assert.rejects(
        f
          .application()
          .saveCandidate(
            { ...f.actor, principalId: "foreign" },
            op.command,
            op.options,
          ),
      );
      await assert.rejects(
        f
          .application()
          .saveCandidate(
            f.actor,
            { ...op.command, expectedArtifactRevision: 2 },
            op.options,
          ),
      );
      const content = changeProjectOutlineDocument(
        saved.contentRevision.content,
        {
          kind: "upsert",
          collection: "characters",
          items: [
            {
              ...saved.contentRevision.content.characters[0]!,
              name: "不同人物名",
            },
          ],
          removeIds: [],
        },
      );
      const altered = saveProjectStructuredOutlineCandidate(
        {
          project: (await f.metadata.loadProject({
            owner: {
              tenantId: f.actor.tenantId,
              spaceId: f.actor.spaceId,
              principalId: f.actor.principalId,
            },
            projectId: f.reference.projectId,
          }))!,
          actor: f.actor,
          artifact: null,
          artifactId: saved.artifact.artifactId,
          expectedArtifactRevision: 0,
          brief: f.brief,
          inputs: saved.contentRevision.inputs,
          content,
          at: saved.artifact.updatedAt,
        },
        digester,
      );
      // A valid independently generated record does not match the original receipt's requested document.
      const differentReceipt = await f.prepare();
      await assert.rejects(
        f.store.commitStructuredOutlineCandidate(
          {
            ...altered,
            actor: f.actor,
            kind: "save-outline",
            expectedArtifactRevision: 0,
            project: (await f.metadata.loadProject({
              owner: {
                tenantId: f.actor.tenantId,
                spaceId: f.actor.spaceId,
                principalId: f.actor.principalId,
              },
              projectId: f.reference.projectId,
            }))!,
            receipt: projectStructuredOutlineCommandReceipt(
              f.actor,
              "save-outline",
              differentReceipt.command,
              digester,
            ),
          },
          differentReceipt.options,
        ),
        outlineHasCause("project_outline_run_commit_qualification_denied"),
      );
      assert.equal(await f.count("project_text_revisions"), 1);
    },
  );

  test(
    `${backend}: a newly confirmed same-parameter plan cannot silently replace the Agent's observed Foundation`,
    options,
    async (t) => {
      const f = await outlineToolFixture(t, backend),
        op = await f.prepare();
      await f.foundation.confirm();
      await assert.rejects(
        f.application().saveCandidate(f.actor, op.command, op.options),
        outlineHasCause("project_outline_run_commit_qualification_denied"),
      );
      assert.equal(await f.count("project_text_revisions"), 0);
      assert.equal(await f.count("project_text_mutation_receipts"), 0);
    },
  );
  test(
    `${backend}: changed Foundation prevents fresh writes`,
    options,
    async (t) => {
      const f = await outlineToolFixture(t, backend),
        op = await f.prepare();
      await f.foundation.invalidate();
      await assert.rejects(
        f.application().saveCandidate(f.actor, op.command, op.options),
      );
      assert.equal(await f.count("project_text_revisions"), 0);
    },
  );
  test(
    `${backend}: revoked actual conversation rejects even a previously committed receipt`,
    options,
    async (t) => {
      const f = await outlineToolFixture(t, backend),
        op = await f.prepare();
      await f.application().saveCandidate(f.actor, op.command, op.options);
      const revoked = f.mutate(f.prepared.binding, "set-state");
      await f.parent
        .projectConversationStore()
        .commitBinding(revoked, { authority: f.authority });
      await assert.rejects(
        f.application().saveCandidate(f.actor, op.command, op.options),
      );
      assert.equal(await f.count("project_text_revisions"), 1);
    },
  );
}

test(
  "sqlite: final original transaction lease loss rolls back candidate and receipt together",
  { timeout: 30000 },
  async (t) => {
    const f = await outlineToolFixture(t, "sqlite"),
      op = await f.prepare();
    const descriptor = Object.getOwnPropertyDescriptor(
      DatabaseSync.prototype,
      "prepare",
    )!;
    let injected = false;
    Object.defineProperty(DatabaseSync.prototype, "prepare", {
      ...descriptor,
      value: function (this: DatabaseSync, sql: string) {
        const statement = Reflect.apply(descriptor.value, this, [sql]) as {
          run(...values: unknown[]): unknown;
        };
        if (/INSERT INTO project_text_mutation_receipts/u.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = (...values: unknown[]) => {
            const result = run(...values);
            this.exec(
              "UPDATE work_items SET lease_expires_at_ms=0 WHERE status='leased'",
            );
            injected = true;
            return result;
          };
        }
        return statement;
      },
    });
    t.after(() =>
      Object.defineProperty(DatabaseSync.prototype, "prepare", descriptor),
    );
    await assert.rejects(
      f.application().saveCandidate(f.actor, op.command, op.options),
      outlineHasCause("creative_project_run_commit_not_current"),
    );
    assert.equal(injected, true);
    assert.equal(await f.count("project_text_revisions"), 0);
    assert.equal(await f.count("project_text_artifacts"), 0);
    assert.equal(await f.count("project_text_mutation_receipts"), 0);
  },
);
