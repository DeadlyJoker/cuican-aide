import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  parkedPostgresGates,
  gateActor,
} from "./postgres-workflow-human-gate.test-support.ts";
import {
  workflowReviewConformance,
  reviewCommand,
  reviewLocator,
} from "./workflow-human-gate-review.test-support.ts";
import { WORKFLOW_GATE_REVIEW_SCOPE } from "./workflow-human-gate-review-receipt.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
async function fixture(t: TestContext) {
  const f = await parkedPostgresGates(t);
  return {
    ...f,
    async reopen() {
      return (await f.open()).experimentalWorkflowRunCompositionStore(f.config);
    },
    async revoked() {
      return (await f.open()).experimentalWorkflowRunCompositionStore({
        ...f.config,
        humanGates: {
          authorize: () => ({ outcome: "deny", reasonCode: "revoked" }),
        },
      });
    },
    async failReceiptWrites() {
      await f.admin.query(
        `CREATE FUNCTION ${f.sql}.fail_review_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.scope='${WORKFLOW_GATE_REVIEW_SCOPE}' THEN RAISE EXCEPTION 'review failure'; END IF; RETURN NEW; END $$`,
      );
      await f.admin.query(
        `CREATE TRIGGER review_insert_failure BEFORE INSERT ON ${f.sql}.idempotency_receipts FOR EACH ROW EXECUTE FUNCTION ${f.sql}.fail_review_insert()`,
      );
    },
    async restoreReceiptWrites() {
      await f.admin.query(
        `DROP TRIGGER review_insert_failure ON ${f.sql}.idempotency_receipts`,
      );
    },
    async corruptReceipt(
      kind: "delete" | "fingerprint" | "decision" | "oversize" | "comment",
    ) {
      const sql = kind === "delete" ? "DELETE FROM" : "UPDATE";
      const change =
        kind === "delete"
          ? ""
          : kind === "fingerprint"
            ? "SET fingerprint='changed'"
            : `SET result_json=jsonb_set(result_json,'${kind === "decision" ? "{decision,decidedAt}" : "{comment}"}',$2::jsonb)`;
      await f.admin.query(
        `${sql} ${f.sql}.idempotency_receipts ${change} WHERE scope=$1`,
        [
          WORKFLOW_GATE_REVIEW_SCOPE,
          ...(kind === "decision"
            ? [JSON.stringify("2026-01-01T00:00:00.000Z")]
            : kind === "oversize"
              ? [JSON.stringify("x".repeat(65537))]
              : kind === "comment"
                ? ["123"]
                : []),
        ],
      );
    },
  };
}
workflowReviewConformance("PostgreSQL", fixture, pgTest);
pgTest(
  "PostgreSQL validates the actual durable decision after review receipt side effects before committing",
  async (t) => {
    const f = await fixture(t),
      before = await f.snapshot();
    await f.admin.query(
      `CREATE FUNCTION ${f.sql}.change_review_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.scope='${WORKFLOW_GATE_REVIEW_SCOPE}' THEN UPDATE ${f.sql}.workflow_human_gates SET decision_json=jsonb_set(decision_json::jsonb,'{actor,actorId}','"changed"'::jsonb)::text WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id AND decision_json IS NOT NULL; END IF; RETURN NEW; END $$`,
    );
    await f.admin.query(
      `CREATE TRIGGER change_review_decision AFTER INSERT ON ${f.sql}.idempotency_receipts FOR EACH ROW EXECUTE FUNCTION ${f.sql}.change_review_decision()`,
    );
    await assert.rejects(
      f.composition.reviewWorkflowHumanGate({
        actor: gateActor,
        command: reviewCommand(f.command),
      }),
      { code: "workflow_gate_authority_conflict" },
    );
    assert.deepEqual(await f.snapshot(), before);
  },
);
pgTest(
  "PostgreSQL concurrent comments commit one exact review and one wake; current grant changes roll back late",
  async (t) => {
    const f = await fixture(t),
      command = reviewCommand(f.command),
      reopened = await f.reopen();
    const results = await Promise.allSettled([
      f.composition.reviewWorkflowHumanGate({ actor: gateActor, command }),
      reopened.reviewWorkflowHumanGate({
        actor: gateActor,
        command: { ...command, comment: "competing" },
      }),
    ]);
    assert.equal(
      results.filter(
        (r) => r.status === "fulfilled" && r.value.disposition === "committed",
      ).length,
      1,
    );
    const rejected = results.find((r) => r.status === "rejected");
    assert.equal(
      rejected?.reason.code,
      "workflow_gate_review_comment_conflict",
    );
    const view = await reopened.loadWorkflowHumanGateReview({
      actor: gateActor,
      locator: reviewLocator(f.command),
    });
    const before = await f.snapshot();
    assert.equal(
      (
        await reopened.reviewWorkflowHumanGate({
          actor: gateActor,
          command: { ...command, comment: view.review!.comment },
        })
      ).disposition,
      "replayed",
    );
    assert.deepEqual(await f.snapshot(), before);
    const other = await fixture(t);
    let checks = 0;
    const lateDenied = (
      await other.open()
    ).experimentalWorkflowRunCompositionStore({
      ...other.config,
      humanGates: {
        authorize: () =>
          ++checks === 1
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "late-revoke" },
      },
    });
    const initial = await other.snapshot();
    await assert.rejects(
      lateDenied.reviewWorkflowHumanGate({
        actor: gateActor,
        command: reviewCommand(other.command),
      }),
      { code: "workflow_gate_authorization_denied" },
    );
    assert.deepEqual(await other.snapshot(), initial);
  },
);
