import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import type { SaveProjectOutlineCandidateCommand } from "./project-text-commands.ts";
import { captureCreativeProjectCommitAuthority } from "./creative-project-commit-authority.ts";
import { captureProjectTextCommitAuthority } from "./project-text-application-support.ts";
import {
  captureProjectTextUiCommitTransaction,
  assertProjectTextUiMutationCommand,
  projectTextUiMutationCommand,
} from "./project-text-ui-commit-authority.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";

const { context } = committedTaskContext(
  committedUiFixture().detachedContext(),
);
const actor = context.actor;
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
function fixture() {
  const selection = context.selection;
  const installation = {
    ...context.package,
    selectionRevision: selection.revision,
  };
  const pin = {
    tenantId: installation.tenantId,
    spaceId: installation.spaceId,
    profileId: installation.profileId,
    pluginId: installation.pluginId,
    publisherId: installation.publisherId,
    version: installation.version,
    packageDigest: installation.packageDigest,
    selectionRevision: installation.selectionRevision,
  };
  const input = {
    projectId: "project",
    request: {
      expectedArtifactRevision: 0,
      briefRevision: 1,
      content: {
        title: "故事",
        logline: "一封信",
        synopsis: "雨夜来信。",
        episodes: [{ episodeId: "ep1", title: "来信", summary: "收到旧信。" }],
      },
    },
    idempotencyKey: "text-original",
  };
  const state = { active: true, calls: 0 };
  const transaction = {
    version: "crewon.project-text-plugin-commit.v1" as const,
    actor,
    installation: pin,
    actionId: "crewon.project-texts.v1.saveOutlineCandidate" as const,
    input,
    selection,
    package: context.package,
    async assertCurrent() {
      state.calls++;
      if (!state.active) throw new Error("original_withdrawn");
    },
  };
  const authority = {
    assertCurrent: async () => {},
    assertActive() {},
    textUiTransaction: transaction,
  };
  return { state, transaction, authority, input };
}
test("text UI capture detaches actual input, binds original callback and is excluded from legacy capture", async () => {
  const f = fixture();
  assert.throws(
    () => captureCreativeProjectCommitAuthority({ authority: f.authority }),
    /authority_invalid/,
  );
  const captured = captureProjectTextCommitAuthority({
    authority: f.authority,
  });
  assert.ok(captured?.textUiTransaction);
  const command = projectTextUiMutationCommand(
    captured.textUiTransaction,
    digester,
  );
  f.input.request.content.synopsis = "later caller mutation";
  f.transaction.assertCurrent = async () => {};
  assert.equal(
    (command.command as SaveProjectOutlineCandidateCommand).content.synopsis,
    "雨夜来信。",
  );
  assert.ok(Object.isFrozen(captured.textUiTransaction.input));
  await captured.textUiTransaction.assertCurrent();
  assert.equal(f.state.calls, 1);
  f.state.active = false;
  await assert.rejects(
    captured.textUiTransaction.assertCurrent(),
    /original_withdrawn/,
  );
});
test("text UI authority rejects getters and multiple protocols without executing them", () => {
  const f = fixture();
  let calls = 0;
  const invalid = { ...f.transaction };
  Object.defineProperty(invalid, "input", {
    enumerable: true,
    get() {
      calls++;
      return f.input;
    },
  });
  assert.throws(() => captureProjectTextUiCommitTransaction(invalid));
  assert.equal(calls, 0);
  assert.throws(
    () =>
      captureProjectTextCommitAuthority({
        authority: { ...f.authority, runTransaction: {} as never },
      }),
    /authority_invalid/,
  );
  assert.throws(
    () =>
      captureProjectTextCommitAuthority({
        authority: { ...f.authority, transaction: {} as never },
      }),
    /unsupported/,
  );
  assert.throws(() =>
    captureProjectTextUiCommitTransaction({
      ...f.transaction,
      actor: { ...actor, spaceId: "foreign" },
    }),
  );
  assert.throws(() =>
    captureProjectTextUiCommitTransaction({
      ...f.transaction,
      installation: {
        ...f.transaction.installation,
        contributionId: "fake-ui",
      },
    }),
  );
});
test("text UI actual action, complete command and original idempotency key must match", () => {
  const f = fixture();
  const tx = captureProjectTextUiCommitTransaction(f.transaction);
  const authority = { ...f.authority, textUiTransaction: tx };
  const actual = projectTextUiMutationCommand(tx, digester);
  assertProjectTextUiMutationCommand(
    authority,
    actor,
    actual.kind,
    actual.command,
    digester,
  );
  assert.throws(() =>
    assertProjectTextUiMutationCommand(
      authority,
      { ...actor, principalId: "foreign" },
      actual.kind,
      actual.command,
      digester,
    ),
  );
  assert.throws(() =>
    assertProjectTextUiMutationCommand(
      authority,
      actor,
      "set-lock",
      actual.command,
      digester,
    ),
  );
  assert.throws(() =>
    assertProjectTextUiMutationCommand(
      authority,
      actor,
      actual.kind,
      { ...actual.command, idempotencyKey: "new-key" },
      digester,
    ),
  );
  const malformed = captureProjectTextUiCommitTransaction({
    ...f.transaction,
    input: {
      ...f.input,
      request: { ...f.input.request, principalId: "foreign" },
    },
  });
  assert.throws(() => projectTextUiMutationCommand(malformed, digester));
});
