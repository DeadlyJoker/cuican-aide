import {
  createProjectStageRunAdmission,
  dispatchToolExecutionReceipt,
  extensionToolName,
  prepareToolExecutionReceipt,
} from "@crewon/domain";
import { canonicalActionIntent } from "@crewon/contracts";
import { foundationRunCommitFixture } from "./project-foundation-run-commit-authority.test-support.ts";
import type { ProjectOutlineRunCommitTransactionAuthority } from "./project-outline-run-commit-authority.ts";

/** Pure protocol fixture; this does not assert live SQL, dispatch or lease eligibility. */
export function outlineRunCommitFixture() {
  const f = foundationRunCommitFixture();
  const request = {
    expectedFoundationRevision: 1,
    projectId: f.facts.binding.projectId,
    expectedArtifactRevision: 1,
    briefRevision: 1,
    base: { contentRevision: 1, contentDigest: f.d.sha256("base") },
    change: {
      kind: "upsert" as const,
      collection: "characters" as const,
      items: [],
      removeIds: ["character-1"],
    },
  };
  const commandInput = JSON.stringify(request);
  const intent = {
    ...f.intent,
    tool: {
      ...f.intent.tool,
      name: extensionToolName(
        f.transaction.installation.pluginId,
        "outline_change",
      ),
      inputDigest: f.d.sha256(commandInput),
    },
  };
  const receipt = dispatchToolExecutionReceipt(
    prepareToolExecutionReceipt({
      receiptId: "outline-receipt",
      tenantId: f.actor.tenantId,
      runId: f.transaction.run.runId,
      stepId: "outline-step",
      attemptId: "outline-attempt",
      workItemId: f.transaction.claim.workItem.workItemId,
      executionId: "outline-execution",
      idempotencyKey: "outline-original-tool-key",
      actionDigest: f.d.sha256(canonicalActionIntent(intent)),
      actionIntent: intent,
      call: {
        segmentId: intent.segmentId,
        callId: intent.callId,
        kind: "function",
        name: intent.tool.name,
        inputDigest: intent.tool.inputDigest,
      },
      effect: "mutation",
      recovery: "reconcilable",
      preparedAt: f.transaction.run.updatedAt,
    }),
    "2026-10-08T00:00:02.000Z",
  );
  const calls = { current: 0, transaction: 0, active: 0 };
  const transaction = {
    version: "crewon.project-outline-run-commit.v2" as const,
    actor: f.actor,
    run: f.transaction.run,
    receipt,
    claim: f.transaction.claim,
    commandInput,
    operationId: "outline_change" as const,
    installation: f.transaction.installation,
    admission: f.transaction.admission,
    projectStageAdmission: createProjectStageRunAdmission(
      {
        actor: f.actor,
        binding: f.facts.binding,
        admission: f.facts.admission,
        extensionBinding: f.facts.extensionBinding,
        stage: { kind: "outline", briefRevision: 1 },
        sources: {
          brief: { briefRevision: 1, contentDigest: f.d.sha256("brief") },
          outline: null,
        },
        at: f.facts.at,
      },
      f.d,
    ),
    selection: f.transaction.selection,
    package: f.transaction.package,
    async assertCurrent() {
      if (this !== transaction) throw new Error("unbound outline callback");
      calls.transaction++;
    },
  } satisfies ProjectOutlineRunCommitTransactionAuthority;
  const authority = {
    outlineRunTransaction: transaction,
    async assertCurrent() {
      calls.current++;
    },
    assertActive() {
      calls.active++;
    },
  };
  return { ...f, request, intent, calls, transaction, authority };
}

/** Rebind fixture input and its own original receipt; never convert another operation's authority. */
export function outlineRunWithRequest(
  f: ReturnType<typeof outlineRunCommitFixture>,
  request: unknown,
) {
  const commandInput = JSON.stringify(request);
  const intent = {
    ...f.intent,
    tool: { ...f.intent.tool, inputDigest: f.d.sha256(commandInput) },
  };
  return {
    ...f.transaction,
    commandInput,
    receipt: {
      ...f.transaction.receipt,
      actionIntent: intent,
      actionDigest: f.d.sha256(canonicalActionIntent(intent)),
      call: {
        ...f.transaction.receipt.call,
        inputDigest: intent.tool.inputDigest,
      },
    },
  };
}
