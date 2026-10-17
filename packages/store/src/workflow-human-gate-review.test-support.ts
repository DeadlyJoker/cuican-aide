import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  WorkflowHumanGateReviewApplicationService,
  type WorkflowHumanGateStore,
  type WorkflowHumanGateReviewStore,
  type DecideWorkflowHumanGateCommand,
} from "@crewon/application";
import { gateActor } from "./workflow-human-gate.test-support.ts";
type ReviewStore = WorkflowHumanGateStore & WorkflowHumanGateReviewStore;
export type ReviewFixture = {
  composition: ReviewStore;
  command: DecideWorkflowHumanGateCommand;
  snapshot(): Promise<unknown>;
  reopen(): Promise<ReviewStore>;
  revoked(): Promise<ReviewStore>;
  failReceiptWrites(): Promise<void>;
  restoreReceiptWrites(): Promise<void>;
  corruptReceipt(
    kind: "delete" | "fingerprint" | "decision" | "oversize" | "comment",
  ): Promise<void>;
};
export function reviewCommand(
  command: DecideWorkflowHumanGateCommand,
  comment: string | null = "  同意\n保留冻结输入。  ",
) {
  return { ...command, kind: "workflowHumanGate.review" as const, comment };
}
export function reviewLocator(command: DecideWorkflowHumanGateCommand) {
  return {
    runId: command.runId,
    nodeId: command.nodeId,
    gateRequestId: command.gateRequestId,
  };
}
export function workflowReviewConformance(
  engine: string,
  fixture: (t: TestContext) => Promise<ReviewFixture>,
  register: (
    name: string,
    run: (t: TestContext) => Promise<void>,
  ) => unknown = test,
) {
  for (const outcome of ["approved", "rejected"] as const)
    register(
      `${engine} review ${outcome} persists exact comment and decision atomically across reopen; v0 remains exact`,
      async (t) => {
        const f = await fixture(t),
          service = new WorkflowHumanGateReviewApplicationService(
            f.composition,
          ),
          locator = reviewLocator(f.command);
        const pending = await service.getReview(gateActor, locator);
        assert.equal(pending.review, null);
        assert.deepEqual(pending.input, { topic: "safe" });
        const command = { ...reviewCommand(f.command), decision: outcome };
        const result = await service.reviewGate(gateActor, command);
        assert.equal(result.disposition, "committed");
        assert.equal(result.review.comment, command.comment);
        assert.deepEqual(Object.keys(result.review.decision).sort(), [
          "actor",
          "authority",
          "decidedAt",
          "outcome",
        ]);
        const before = await f.snapshot(),
          reopened = await f.reopen();
        assert.deepEqual(
          await reopened.reviewWorkflowHumanGate({ actor: gateActor, command }),
          { disposition: "replayed", review: result.review },
        );
        const view = await reopened.loadWorkflowHumanGateReview({
          actor: gateActor,
          locator,
        });
        assert.deepEqual(view.review, result.review);
        assert.deepEqual(view.input, pending.input);
        const legacy = await reopened.decideWorkflowHumanGate({
          actor: gateActor,
          command: { ...f.command, decision: outcome },
        });
        assert.deepEqual(legacy, {
          disposition: "replayed",
          decision: result.review.decision,
        });
        assert.deepEqual(await f.snapshot(), before);
        for (const comment of [null, "", "modified"])
          await assert.rejects(
            reopened.reviewWorkflowHumanGate({
              actor: gateActor,
              command: { ...command, comment },
            }),
            { code: "workflow_gate_review_comment_conflict" },
          );
        assert.deepEqual(await f.snapshot(), before);
      },
    );
  for (const comment of [null, "", "\ufeff\r\n😀"])
    register(
      `${engine} review preserves exact ${JSON.stringify(comment)} without conflating null and empty`,
      async (t) => {
        const f = await fixture(t),
          command = reviewCommand(f.command, comment);
        const result = await f.composition.reviewWorkflowHumanGate({
          actor: gateActor,
          command,
        });
        assert.equal(result.review.comment, comment);
        await assert.rejects(
          f.composition.reviewWorkflowHumanGate({
            actor: gateActor,
            command: { ...command, comment: comment === null ? "" : null },
          }),
          { code: "workflow_gate_review_comment_conflict" },
        );
      },
    );
  register(
    `${engine} review never fabricates or retroactively adds a comment to a v0 decision`,
    async (t) => {
      const f = await fixture(t);
      await f.composition.decideWorkflowHumanGate({
        actor: gateActor,
        command: f.command,
      });
      const before = await f.snapshot();
      await assert.rejects(
        f.composition.loadWorkflowHumanGateReview({
          actor: gateActor,
          locator: reviewLocator(f.command),
        }),
        { code: "workflow_gate_review_not_recorded_conflict" },
      );
      await assert.rejects(
        f.composition.reviewWorkflowHumanGate({
          actor: gateActor,
          command: reviewCommand(f.command, null),
        }),
        { code: "workflow_gate_review_not_recorded_conflict" },
      );
      assert.deepEqual(await f.snapshot(), before);
    },
  );
  register(
    `${engine} review rechecks current approval grants on read and replay and refuses changed input`,
    async (t) => {
      const f = await fixture(t),
        command = reviewCommand(f.command),
        before = await f.snapshot();
      await assert.rejects(
        f.composition.reviewWorkflowHumanGate({
          actor: gateActor,
          command: { ...command, inputDigest: `sha256:${"0".repeat(64)}` },
        }),
        { code: "workflow_gate_input_conflict" },
      );
      await assert.rejects(
        f.composition.reviewWorkflowHumanGate({
          actor: { ...gateActor, principalId: "other" },
          command,
        }),
        { code: "workflow_gate_authorization_denied" },
      );
      await assert.rejects(
        f.composition.loadWorkflowHumanGateReview({
          actor: { ...gateActor, spaceId: "other" },
          locator: reviewLocator(f.command),
        }),
        { code: "workflow_gate_not_found" },
      );
      assert.deepEqual(await f.snapshot(), before);
      await f.composition.reviewWorkflowHumanGate({
        actor: gateActor,
        command,
      });
      const committed = await f.snapshot(),
        denied = await f.revoked();
      await assert.rejects(
        denied.loadWorkflowHumanGateReview({
          actor: gateActor,
          locator: reviewLocator(f.command),
        }),
        { code: "workflow_gate_authorization_denied" },
      );
      await assert.rejects(
        denied.reviewWorkflowHumanGate({ actor: gateActor, command }),
        { code: "workflow_gate_authorization_denied" },
      );
      assert.deepEqual(await f.snapshot(), committed);
    },
  );
  register(
    `${engine} failed review receipt insert rolls back decision, gate output, sibling cancellation and wake`,
    async (t) => {
      const f = await fixture(t),
        before = await f.snapshot(),
        command = {
          ...reviewCommand(f.command),
          decision: "rejected" as const,
        };
      await f.failReceiptWrites();
      await assert.rejects(
        f.composition.reviewWorkflowHumanGate({ actor: gateActor, command }),
      );
      assert.deepEqual(await f.snapshot(), before);
      await f.restoreReceiptWrites();
      assert.equal(
        (
          await f.composition.reviewWorkflowHumanGate({
            actor: gateActor,
            command,
          })
        ).disposition,
        "committed",
      );
    },
  );
  for (const kind of [
    "delete",
    "fingerprint",
    "decision",
    "oversize",
    "comment",
  ] as const)
    register(
      `${engine} ${kind} review receipt refuses read/replay without repairing evidence`,
      async (t) => {
        const f = await fixture(t),
          command = reviewCommand(f.command);
        await f.composition.reviewWorkflowHumanGate({
          actor: gateActor,
          command,
        });
        await f.corruptReceipt(kind);
        const before = await f.snapshot();
        const code =
          kind === "delete"
            ? "workflow_gate_review_not_recorded_conflict"
            : "workflow_gate_review_corrupt";
        await assert.rejects(
          f.composition.loadWorkflowHumanGateReview({
            actor: gateActor,
            locator: reviewLocator(f.command),
          }),
          { code },
        );
        await assert.rejects(
          f.composition.reviewWorkflowHumanGate({ actor: gateActor, command }),
          { code },
        );
        assert.deepEqual(await f.snapshot(), before);
      },
    );
}
