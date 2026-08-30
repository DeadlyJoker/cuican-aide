import assert from "node:assert/strict";
import test from "node:test";

import { parseRunView, RunViewValidationError } from "./run-view.ts";

test("accepts the complete Run status enum with canonical terminal fields", () => {
  const nonterminal = [
    run(),
    run({ status: "running", revision: 2, lastSequence: 2 }),
    run({
      status: "waitingApproval",
      revision: 2,
      lastSequence: 2,
      waitingApproval: { approvalId: "approval-1" },
    }),
    run({ status: "suspended", revision: 2, lastSequence: 2 }),
    run({ status: "reconciling", revision: 2, lastSequence: 2 }),
  ];
  const terminal = [
    run({
      status: "completed",
      revision: 2,
      lastSequence: 2,
      updatedAt: "2026-08-09T00:00:02Z",
      terminalAt: "2026-08-09T00:00:02Z",
      outputRef: "message:message-1",
    }),
    run({
      status: "failed",
      revision: 2,
      lastSequence: 2,
      updatedAt: "2026-08-09T00:00:02Z",
      terminalAt: "2026-08-09T00:00:02Z",
      failure: { code: "provider_failed", retryable: true },
    }),
    run({
      status: "canceled",
      revision: 3,
      lastSequence: 3,
      cancelRequested: true,
      updatedAt: "2026-08-09T00:00:03Z",
      terminalAt: "2026-08-09T00:00:03Z",
    }),
  ];

  assert.deepEqual(
    [...nonterminal, ...terminal].map((value) => parseRunView(value).status),
    [
      "queued",
      "running",
      "waitingApproval",
      "suspended",
      "reconciling",
      "completed",
      "failed",
      "canceled",
    ],
  );
});

test("rejects unknown statuses, terminal drift and nested extra fields", () => {
  for (const malformed of [
    run({ status: "unknown" }),
    run({ status: "completed" }),
    run({
      status: "failed",
      revision: 2,
      lastSequence: 2,
      updatedAt: "2026-08-09T00:00:02Z",
      terminalAt: "2026-08-09T00:00:02Z",
      failure: { code: "failed", retryable: false, private: true },
    }),
    run({
      status: "waitingApproval",
      revision: 2,
      lastSequence: 2,
      waitingApproval: null,
    }),
  ]) {
    assert.throws(
      () => parseRunView(malformed),
      (error) => error instanceof RunViewValidationError,
    );
  }
});

test("accepts a workflow Run only with its exact version binding", () => {
  const binding = {
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    contentDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const workflowRun = run({ purpose: "workflow", workflowVersionBinding: binding });

  assert.deepEqual(parseRunView(workflowRun).workflowVersionBinding, binding);

  for (const malformed of [
    // A workflow Run without provenance cannot be trusted to resume.
    run({ purpose: "workflow", workflowVersionBinding: null }),
    // A non-workflow Run must not carry workflow provenance.
    run({ purpose: "turn", workflowVersionBinding: binding }),
    run({
      purpose: "workflow",
      workflowVersionBinding: { ...binding, contentDigest: "not-a-digest" },
    }),
  ]) {
    assert.throws(
      () => parseRunView(malformed),
      (error) => error instanceof RunViewValidationError,
    );
  }
});

function run(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    threadId: "thread-1",
    status: "queued",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "turn",
    workflowVersionBinding: null,
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-09T00:00:01Z",
    updatedAt: "2026-08-09T00:00:01Z",
    terminalAt: null,
    ...overrides,
  };
}
