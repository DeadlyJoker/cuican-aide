import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ProjectAssetApplicationService,
  projectAssetUiMutationCommand,
  projectAssetMutationReceipt,
  type ProjectAssetUiMutationAction,
  type ProjectAssetCommitAuthority,
  type ProjectAssetRecoveryCommitAuthority,
} from "@crewon/application";
import { type ProjectAssetUiIntentScope } from "@crewon/domain";
import { textUiCommitFixture } from "./project-text-ui-commit.test-support.ts";
import { textDigester } from "./project-text-store.test-support.ts";
import { intentHash } from "./project-asset-ui-intent-support.ts";
export const assetAt = "2026-10-06T08:00:00.000Z";
export const assetContent = Object.freeze({
  name: "林予",
  setting: "修复师，习惯收藏旧信。",
  visualPrompt: "A film portrait, soft light.",
});
/** Real parent, project, brief, installation and both archives. Grants below are named Store-port fixtures, not Native/UI issuers. */
export async function projectAssetFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await textUiCommitFixture(t, backend),
    store = f.parent.projectAssetStore();
  await store.migrate();
  const journal = f.parent.projectAssetUiIntentJournalStore();
  await journal.migrate();
  const assets = new ProjectAssetApplicationService({
    store,
    projects: f.parent.creativeProjectStore(),
    texts: f.parent.projectTextStore(),
    authorization: {
      authorize: async () =>
        f.policy.allow
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named_asset_policy_denied" },
    },
    clock: { now: () => assetAt },
    ids: { nextId: () => randomUUID() },
    digester: textDigester,
  });
  const scope: ProjectAssetUiIntentScope = {
    actor: f.actor,
    installation: f.installation,
    contributionId: "workbench",
  };
  function mutation(
    actionId: ProjectAssetUiMutationAction,
    input: unknown,
    journaled = true,
  ) {
    const old = f.legacyGrant(),
      tx = old.authority.transaction;
    assert.ok(tx);
    const base = {
      version: "crewon.project-asset-plugin-commit.v1" as const,
      actor: f.actor,
      installation: f.installation,
      contributionId: "workbench",
      actionId,
      input: input as never,
      selection: f.source.selection,
      package: f.source.package,
      assertCurrent: tx.assertCurrent.bind(tx),
    };
    const actual = projectAssetUiMutationCommand(base),
      receipt = projectAssetMutationReceipt(
        f.actor,
        actual.kind,
        actual.command,
        textDigester,
      ),
      intentId = `asset-intent-${intentHash({ scope, actionId, receipt }).slice(7)}`;
    const authority: ProjectAssetCommitAuthority = {
      assertActive: old.authority.assertActive,
      assertCurrent: old.authority.assertCurrent,
      assertTransactionCurrent: tx.assertCurrent,
      uiTransaction: {
        ...base,
        ...(journaled
          ? { intentRef: { intentId, requestDigest: receipt.requestDigest } }
          : {}),
      },
    };
    return {
      authority,
      options: { authority },
      state: old.state,
      scope,
      actionId,
      input,
      intentId,
      actual,
      receipt,
    };
  }
  const creation = (
    key = "asset-create",
    projectId = f.project.project.projectId,
  ) =>
    mutation("crewon.project-assets.v1.saveCandidate", {
      projectId,
      assetId: null,
      request: {
        kind: "character",
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: assetContent,
      },
      idempotencyKey: key,
    });
  const stage = (g: ReturnType<typeof mutation>, target = journal) =>
    target.stage(
      {
        scope: g.scope,
        actionId: g.actionId,
        input: g.input,
        intentId: g.intentId,
        at: assetAt,
      },
      g.options,
    );
  async function write(g: ReturnType<typeof mutation>, target = assets) {
    switch (g.actual.kind) {
      case "save-content":
        return target.saveCandidate(
          f.actor,
          g.actual.command as never,
          g.options,
        );
      case "select-content":
        return target.selectRevision(
          f.actor,
          g.actual.command as never,
          g.options,
        );
      case "set-lock":
        return target.setLocked(f.actor, g.actual.command as never, g.options);
      case "save-reference":
        return target.saveReferenceCandidate(
          f.actor,
          g.actual.command as never,
          g.options,
        );
      case "select-reference":
        return target.selectReference(
          f.actor,
          g.actual.command as never,
          g.options,
        );
    }
  }
  function recovery(
    method: "getPending" | "acknowledge",
    input: unknown,
    source = scope,
  ) {
    const old = f.legacyGrant(),
      tx = old.authority.transaction;
    assert.ok(tx);
    const authority: ProjectAssetRecoveryCommitAuthority = {
      assertCurrent: old.authority.assertCurrent,
      assertTransactionCurrent: tx.assertCurrent,
      assertActive: old.authority.assertActive,
      recoveryTransaction: {
        version: "crewon.project-asset-recovery-commit.v1",
        actor: source.actor,
        installation: source.installation,
        contributionId: source.contributionId,
        actionId:
          method === "getPending"
            ? "crewon.project-asset-recovery.v1.getPending"
            : "crewon.project-asset-recovery.v1.acknowledge",
        input: input as never,
        selection: f.source.selection,
        package: f.source.package,
        assertCurrent: tx.assertCurrent,
      },
    };
    return { authority, options: { authority }, state: old.state };
  }
  const pending = (target = journal) =>
    target.getPending({ scope }, recovery("getPending", {}).options);
  const ack = (r: { intentId: string; revision: number }, target = journal) =>
    target.acknowledge(
      {
        scope,
        intentId: r.intentId,
        expectedRevision: r.revision,
        at: assetAt,
      },
      recovery("acknowledge", {
        intentId: r.intentId,
        expectedRevision: r.revision,
      }).options,
    );
  return {
    ...f,
    assetStore: store,
    journal,
    assets,
    scope,
    mutation,
    creation,
    stage,
    write,
    recovery,
    pending,
    ack,
    digester: textDigester,
  };
}
export const assetTestOptions = (backend: "sqlite" | "postgres") => ({
  skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 30000,
});
export const hasAssetCause =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof Error &&
    (error.message === code ||
      ("code" in error && error.code === code) ||
      hasAssetCause(code)(error.cause));
