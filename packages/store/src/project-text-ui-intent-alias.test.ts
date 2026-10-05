import assert from "node:assert/strict";
import test from "node:test";
import { projectRunCommitFixture } from "./creative-project-run-commit.test-support.ts";
import {
  projectTextUiMutationCommand,
  type CreativeProjectCommitOptions,
  type ProjectTextUiCommitTransactionAuthority,
  type ProjectTextRecoveryCommitAuthority,
} from "@crewon/application";
import { textIntentHash } from "./project-text-ui-intent-support.ts";
const error =
  (pattern: RegExp) =>
  (e: unknown): boolean =>
    e instanceof Error &&
    (pattern.test(e.message) ||
      (e.cause !== undefined && error(pattern)(e.cause)));
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30000,
  };
  test(
    `${backend} genuine admitted Run/Tool cannot borrow a journal-reserved accepted or ACKed receipt key`,
    options,
    async (t) => {
      const f = await projectRunCommitFixture(t, backend);
      const project = await f.projects.createProject(f.actor, {
        title: "夜航",
        briefText: "一封旧信。",
        idempotencyKey: "run-alias-project",
      });
      const op = await f.prepareOperation("outline_save", {
        projectId: project.project.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: {
          title: "夜航",
          logline: "旧信",
          synopsis: "雨夜发现旧信。",
          episodes: [
            { episodeId: "ep-1", title: "来信", summary: "发现旧信。" },
          ],
        },
      });
      const journal = f.parent.projectTextUiIntentJournalStore();
      await journal.migrate();
      const scope = {
        actor: f.actor,
        installation: op.transaction.installation,
        contributionId: "workbench",
        projectId: project.project.projectId,
      };
      const input = {
        projectId: scope.projectId,
        request: {
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: (op.normalized.command as { content: unknown }).content,
        },
        idempotencyKey: op.normalized.receipt.idempotencyKey,
      };
      const base: ProjectTextUiCommitTransactionAuthority = {
        version: "crewon.project-text-plugin-commit.v1",
        actor: f.actor,
        installation: op.transaction.installation,
        contributionId: "workbench",
        actionId: "crewon.project-texts.v1.saveOutlineCandidate",
        input,
        selection: op.transaction.selection,
        package: op.transaction.package,
        assertCurrent: op.transaction.assertCurrent,
      };
      const actual = projectTextUiMutationCommand(base, f.digester);
      assert.deepEqual(actual.receipt, op.normalized.receipt);
      const originalAuthority = op.options.authority;
      assert.ok(originalAuthority);
      const intentId = textIntentHash({
        scope,
        actionId: base.actionId,
        receipt: actual.receipt,
      });
      const options: CreativeProjectCommitOptions = {
        authority: {
          assertActive: originalAuthority.assertActive,
          assertCurrent: originalAuthority.assertCurrent,
          textUiTransaction: {
            ...base,
            intentRef: {
              intentId,
              requestDigest: actual.receipt.requestDigest,
            },
          },
        },
      };
      const at = new Date().toISOString();
      await journal.stage(
        { scope, actionId: base.actionId, input, intentId, at },
        options,
      );
      await f.text.saveOutlineCandidate(
        f.actor,
        actual.command as never,
        options,
      );
      const readAuthority = (
        actionId:
          | "crewon.project-text-recovery.v1.getPending"
          | "crewon.project-text-recovery.v1.acknowledge",
        body: unknown,
      ): ProjectTextRecoveryCommitAuthority => ({
        assertActive: originalAuthority.assertActive,
        assertCurrent: originalAuthority.assertCurrent,
        recoveryTransaction: {
          version: "crewon.project-text-recovery-commit.v1",
          actor: f.actor,
          installation: base.installation,
          contributionId: "workbench",
          actionId,
          input: body as never,
          selection: base.selection,
          package: base.package,
          assertCurrent: base.assertCurrent,
        },
      });
      const accepted = await journal.getPending(
        { scope },
        {
          authority: readAuthority(
            "crewon.project-text-recovery.v1.getPending",
            { projectId: scope.projectId },
          ),
        },
      );
      assert.ok(accepted);
      assert.equal(accepted.phase, "accepted");
      const before = await f.counts();
      await assert.rejects(
        f.text.saveOutlineCandidate(
          f.actor,
          op.normalized.command as never,
          op.options,
        ),
        error(/intent_authority_required/u),
      );
      await journal.acknowledge(
        {
          scope,
          intentId,
          expectedRevision: accepted.revision,
          at: new Date().toISOString(),
        },
        {
          authority: readAuthority(
            "crewon.project-text-recovery.v1.acknowledge",
            {
              projectId: scope.projectId,
              intentId,
              expectedRevision: accepted.revision,
            },
          ),
        },
      );
      await assert.rejects(
        f.text.saveOutlineCandidate(
          f.actor,
          op.normalized.command as never,
          op.options,
        ),
        error(/intent_authority_required/u),
      );
      assert.deepEqual(await f.counts(), before);
    },
  );
}
