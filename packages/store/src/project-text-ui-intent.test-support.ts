import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  projectTextUiMutationCommand,
  type ProjectTextUiMutationAction,
  type ProjectTextRecoveryCommitAuthority,
  type CreativeProjectCommitAuthority,
} from "@crewon/application";
import type { ProjectTextUiIntentScope } from "@crewon/domain";
import { textUiCommitFixture } from "./project-text-ui-commit.test-support.ts";
import { textIntentHash } from "./project-text-ui-intent-support.ts";
import { textAt, textDigester } from "./project-text-store.test-support.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";

export const intentOutline = {
  title: "夜航",
  logline: "旧信",
  synopsis: "雨夜发现旧信。",
  episodes: [{ episodeId: "ep-1", title: "来信", summary: "发现旧信。" }],
};
export const intentScript = {
  title: "来信",
  scenes: [
    {
      sceneId: "scene-1",
      location: "工作室",
      timeOfDay: "夜",
      action: "拆开旧信。",
      dialogue: [{ speaker: "修复师", text: "是谁寄来的？" }],
    },
  ],
};
export const intentAt = "2026-10-06T00:00:00.000Z";
export async function textIntentFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await textUiCommitFixture(t, backend);
  const journal = f.parent.projectTextUiIntentJournalStore();
  await journal.migrate();
  const scope: ProjectTextUiIntentScope = Object.freeze({
    actor: f.actor,
    installation: f.installation,
    contributionId: "workbench",
    projectId: f.project.project.projectId,
  });
  function mutation(
    actionId: ProjectTextUiMutationAction,
    input: unknown,
    source = scope,
  ) {
    const old = f.grant(actionId, input),
      tx = old.authority.textUiTransaction;
    assert.ok(tx);
    const actual = projectTextUiMutationCommand(tx, textDigester);
    const intentId = textIntentHash({
      scope: source,
      actionId,
      receipt: actual.receipt,
    });
    const authority: CreativeProjectCommitAuthority = Object.freeze({
      ...old.authority,
      textUiTransaction: Object.freeze({
        ...tx,
        contributionId: source.contributionId,
        intentRef: Object.freeze({
          intentId,
          requestDigest: actual.receipt.requestDigest,
        }),
      }),
    });
    return {
      ...old,
      authority,
      options: { authority },
      scope: source,
      intentId,
      actionId,
      input,
      actual,
    };
  }
  const outline = (key = "outline-key", expectedArtifactRevision = 0) =>
    mutation("crewon.project-texts.v1.saveOutlineCandidate", {
      projectId: scope.projectId,
      request: {
        expectedArtifactRevision,
        briefRevision: 1,
        content: intentOutline,
      },
      idempotencyKey: key,
    });
  async function stage(g: ReturnType<typeof mutation>, target = journal) {
    return target.stage(
      {
        scope: g.scope,
        actionId: g.actionId,
        input: g.input,
        intentId: g.intentId,
        at: intentAt,
      },
      g.options,
    );
  }
  async function write(g: ReturnType<typeof mutation>) {
    const c = g.actual.command;
    switch (g.actual.kind) {
      case "save-outline":
        return f.text.saveOutlineCandidate(f.actor, c as never, g.options);
      case "save-script":
        return f.text.saveScriptCandidate(f.actor, c as never, g.options);
      case "select-revision":
        return f.text.selectRevision(f.actor, c as never, g.options);
      case "set-lock":
        return f.text.setLocked(f.actor, c as never, g.options);
    }
  }
  function recovery(
    method: "getPending" | "acknowledge",
    input: unknown,
    source = scope,
  ) {
    const old = f.legacyGrant(),
      legacy = old.authority.transaction;
    assert.ok(legacy);
    const authority: ProjectTextRecoveryCommitAuthority = {
      assertCurrent: old.authority.assertCurrent.bind(old.authority),
      assertActive: old.authority.assertActive.bind(old.authority),
      recoveryTransaction: {
        version: "crewon.project-text-recovery-commit.v1",
        actor: source.actor,
        installation: source.installation,
        contributionId: source.contributionId,
        actionId:
          method === "getPending"
            ? "crewon.project-text-recovery.v1.getPending"
            : "crewon.project-text-recovery.v1.acknowledge",
        input: input as never,
        selection: f.source.selection,
        package: f.source.package,
        assertCurrent: legacy.assertCurrent.bind(legacy),
      },
    };
    return { authority, state: old.state, options: { authority } };
  }
  async function pending(target = journal, source = scope) {
    const r = recovery("getPending", { projectId: source.projectId }, source);
    return target.getPending({ scope: source }, r.options);
  }
  async function ack(
    record: { intentId: string; revision: number },
    target = journal,
  ) {
    const r = recovery("acknowledge", {
      projectId: scope.projectId,
      intentId: record.intentId,
      expectedRevision: record.revision,
    });
    return target.acknowledge(
      {
        scope,
        intentId: record.intentId,
        expectedRevision: record.revision,
        at: intentAt,
      },
      r.options,
    );
  }
  async function reopen() {
    const parent =
      backend === "sqlite"
        ? new SqliteRunStore(
            String(f.database?.prepare("PRAGMA database_list").get()?.file),
          )
        : await PostgresDomainStore.open({
            connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
            schema: f.schema,
            maxPoolSize: 1,
          });
    t.after(() => parent.close());
    return {
      parent,
      journal: parent.projectTextUiIntentJournalStore(),
      text: parent.projectTextStore(),
    };
  }
  return {
    ...f,
    journal,
    scope,
    mutation,
    outline,
    stage,
    write,
    recovery,
    pending,
    ack,
    reopen,
    textAt,
  };
}
