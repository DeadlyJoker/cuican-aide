import { MAX_PROPOSED_PLAN_BYTES } from "@crewon/domain";

const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";

export class PlanOutputError extends Error {
  readonly code = "plan_output_invalid";

  constructor() {
    super("plan_output_invalid");
    this.name = "PlanOutputError";
  }
}

/** Validates the Plan-mode terminal envelope and returns its UI-visible body. */
export function parseProposedPlan(output: string): string {
  const trimmed = output.trim();
  if (!trimmed.startsWith(OPEN_TAG) || !trimmed.endsWith(CLOSE_TAG)) {
    throw new PlanOutputError();
  }
  if (
    trimmed.indexOf(OPEN_TAG, OPEN_TAG.length) !== -1 ||
    trimmed.indexOf(CLOSE_TAG) !== trimmed.length - CLOSE_TAG.length
  ) {
    throw new PlanOutputError();
  }
  const plan = trimmed.slice(OPEN_TAG.length, -CLOSE_TAG.length).trim();
  if (
    plan.length === 0 ||
    new TextEncoder().encode(plan).byteLength > MAX_PROPOSED_PLAN_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(plan)
  ) {
    throw new PlanOutputError();
  }
  return plan;
}
