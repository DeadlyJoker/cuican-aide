import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import { captureWorkflowControlJson } from "./workflow-control-json.ts";
import {
  MAX_WORKFLOW_GATE_RESPONSE_BYTES,
  parseDecideWorkflowHumanGateRequest,
  parseWorkflowHumanGateResponse,
  parseWorkflowHumanGateMutationResponse,
  type WorkflowGateLocator,
} from "./workflow-run-read-contract.ts";

export type WorkflowHumanGateReviewResponse =
  components["schemas"]["WorkflowHumanGateReviewResponse"];
export type WorkflowHumanGateReviewMutationResponse =
  components["schemas"]["WorkflowHumanGateReviewMutationResponse"];
export type ReviewWorkflowHumanGateRequest =
  components["schemas"]["ReviewWorkflowHumanGateRequest"];
export type WorkflowReviewCapability =
  components["schemas"]["WorkflowReviewCapability"];
export const WORKFLOW_HUMAN_GATE_COMMENT_MAX_BYTES = 4096;
export const MAX_WORKFLOW_GATE_REVIEW_REQUEST_BYTES = 32768;
function invalid(): never {
  throw new ContractValidationError("workflow_review_invalid");
}
function fields(value: unknown, expected: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...expected].sort().join()
  )
    invalid();
  return value as Record<string, unknown>;
}
export function parseWorkflowHumanGateReviewComment(
  value: unknown,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    value.length > WORKFLOW_HUMAN_GATE_COMMENT_MAX_BYTES
  )
    invalid();
  const bytes = new TextEncoder().encode(value);
  if (
    bytes.byteLength > WORKFLOW_HUMAN_GATE_COMMENT_MAX_BYTES ||
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !==
      value
  )
    invalid();
  return value;
}
export function parseWorkflowReviewCapability(
  value: unknown,
): WorkflowReviewCapability {
  const row = fields(captureWorkflowControlJson(value, 1024), [
    "version",
    "available",
  ]);
  if (row.version !== "v1" || typeof row.available !== "boolean") invalid();
  return Object.freeze(row) as WorkflowReviewCapability;
}
export function parseReviewWorkflowHumanGateRequest(
  value: unknown,
): ReviewWorkflowHumanGateRequest {
  const row = fields(
    captureWorkflowControlJson(value, MAX_WORKFLOW_GATE_REVIEW_REQUEST_BYTES),
    ["inputDigest", "decision", "comment"],
  );
  return {
    ...parseDecideWorkflowHumanGateRequest({
      inputDigest: row.inputDigest,
      decision: row.decision,
    }),
    comment: parseWorkflowHumanGateReviewComment(row.comment),
  };
}
export function parseWorkflowHumanGateReviewResponse(
  value: unknown,
  locator: WorkflowGateLocator,
): WorkflowHumanGateReviewResponse {
  const row = fields(
    captureWorkflowControlJson(value, MAX_WORKFLOW_GATE_RESPONSE_BYTES),
    [
      "schemaVersion",
      "authority",
      "title",
      "instruction",
      "input",
      "status",
      "review",
    ],
  );
  if (row.schemaVersion !== "crewon.workflow-human-gate-review.v1") invalid();
  const { review, schemaVersion: _version, ...base } = row;
  const chosen =
    review === null ? null : fields(review, ["decision", "comment"]);
  const old = parseWorkflowHumanGateResponse(
    {
      ...base,
      schemaVersion: "crewon.workflow-human-gate.v0",
      decision: chosen?.decision ?? null,
    },
    locator,
  );
  if (chosen && old.decision === null) invalid();
  const { decision, schemaVersion: _oldVersion, ...view } = old;
  return {
    ...view,
    schemaVersion: "crewon.workflow-human-gate-review.v1",
    review: chosen
      ? {
          decision: decision!,
          comment: parseWorkflowHumanGateReviewComment(chosen.comment),
        }
      : null,
  };
}
export function parseWorkflowHumanGateReviewMutationResponse(
  value: unknown,
  locator: WorkflowGateLocator,
  command: ReviewWorkflowHumanGateRequest,
): WorkflowHumanGateReviewMutationResponse {
  const expected = parseReviewWorkflowHumanGateRequest(command);
  const row = fields(
    captureWorkflowControlJson(value, MAX_WORKFLOW_GATE_RESPONSE_BYTES),
    ["disposition", "review"],
  );
  const chosen = fields(row.review, ["decision", "comment"]);
  const comment = parseWorkflowHumanGateReviewComment(chosen.comment);
  if (comment !== expected.comment) invalid();
  const old = parseWorkflowHumanGateMutationResponse(
    { disposition: row.disposition, decision: chosen.decision },
    locator,
    { inputDigest: expected.inputDigest, decision: expected.decision },
  );
  return {
    disposition: old.disposition,
    review: { decision: old.decision, comment },
  };
}
