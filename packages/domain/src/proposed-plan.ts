export const MAX_PROPOSED_PLAN_BYTES = 9_999;

export type ProposedPlan = Readonly<{
  schemaVersion: "crewon.proposed-plan.v0";
  planId: string;
  tenantId: string;
  threadId: string;
  runId: string;
  messageId: string;
  content: string;
  contentDigest: string;
  createdAt: string;
}>;

export class ProposedPlanError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ProposedPlanError";
    this.code = code;
  }
}

export function validateProposedPlan(value: ProposedPlan): void {
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().join("\0") !==
      [
        "content",
        "contentDigest",
        "createdAt",
        "messageId",
        "planId",
        "runId",
        "schemaVersion",
        "tenantId",
        "threadId",
      ].join("\0") ||
    value.schemaVersion !== "crewon.proposed-plan.v0"
  ) {
    throw new ProposedPlanError("proposed_plan_shape_invalid");
  }
  requireBoundedText(value.planId, 512, "proposed_plan_id_invalid");
  requireBoundedText(value.tenantId, 512, "proposed_plan_tenant_invalid");
  requireBoundedText(value.threadId, 512, "proposed_plan_thread_invalid");
  requireBoundedText(value.runId, 512, "proposed_plan_run_invalid");
  requireBoundedText(value.messageId, 512, "proposed_plan_message_invalid");
  requireBoundedText(
    value.content,
    MAX_PROPOSED_PLAN_BYTES,
    "proposed_plan_content_invalid",
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.contentDigest)) {
    throw new ProposedPlanError("proposed_plan_digest_invalid");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(
      value.createdAt,
    ) ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new ProposedPlanError("proposed_plan_created_at_invalid");
  }
}

function requireBoundedText(value: string, maxBytes: number, code: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new ProposedPlanError(code);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
