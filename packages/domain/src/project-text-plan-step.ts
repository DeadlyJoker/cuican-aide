import type { ExtensionContentDigester } from "./extension-configuration.ts";
import type {
  ProjectTextPlanResultReference,
  ProjectTextPlanSelectionReference,
  ProjectTextPlanStep,
} from "./project-text-plan-types.ts";
import {
  planRecord,
  planId,
  planRevision,
  planEnum,
  planNullable,
  planTimes,
  planChecked,
  planCreated,
  planFailure,
  planStage,
  planDigest,
  planSources,
  parseProjectTextPlanBaseline,
  planInteger,
} from "./project-text-plan-validation.ts";

export function parseProjectTextPlanResultReference(
  input: unknown,
): ProjectTextPlanResultReference {
  const v = planRecord(input, [
    "kind",
    "idempotencyKey",
    "requestDigest",
    "runId",
    "toolReceiptId",
    "toolInputDigest",
    "briefRevision",
    "artifactId",
    "artifactRevision",
    "contentRevision",
    "contentDigest",
  ]);
  const kind = planStage(v.kind),
    briefRevision = planNullable(v.briefRevision, planRevision),
    artifactId = planNullable(v.artifactId, planId),
    artifactRevision = planNullable(v.artifactRevision, planRevision),
    contentRevision = planNullable(v.contentRevision, planRevision);
  if (
    kind === "brief"
      ? briefRevision === null ||
        artifactId !== null ||
        artifactRevision !== null ||
        contentRevision !== null
      : briefRevision !== null ||
        artifactId === null ||
        artifactRevision === null ||
        contentRevision === null
  )
    planFailure();
  return Object.freeze({
    kind,
    idempotencyKey: planId(v.idempotencyKey),
    requestDigest: planDigest(v.requestDigest),
    runId: planId(v.runId),
    toolReceiptId: planId(v.toolReceiptId),
    toolInputDigest: planDigest(v.toolInputDigest),
    briefRevision,
    artifactId,
    artifactRevision,
    contentRevision,
    contentDigest: planDigest(v.contentDigest),
  });
}
export function parseProjectTextPlanSelectionReference(
  input: unknown,
): ProjectTextPlanSelectionReference {
  const v = planRecord(input, [
    "mode",
    "idempotencyKey",
    "requestDigest",
    "artifactId",
    "artifactRevision",
    "contentRevision",
    "contentDigest",
  ]);
  return Object.freeze({
    mode: planEnum(v.mode, ["manual", "whenUnchanged"]),
    idempotencyKey: planId(v.idempotencyKey),
    requestDigest: planDigest(v.requestDigest),
    artifactId: planId(v.artifactId),
    artifactRevision: planRevision(v.artifactRevision),
    contentRevision: planRevision(v.contentRevision),
    contentDigest: planDigest(v.contentDigest),
  });
}
export function parseProjectTextPlanStep(
  input: unknown,
  digester: ExtensionContentDigester,
): ProjectTextPlanStep {
  const v = planRecord(input, [
    "schemaVersion",
    "planId",
    "planRevision",
    "stepId",
    "ordinal",
    "kind",
    "episodeId",
    "attempt",
    "revision",
    "state",
    "sources",
    "baseline",
    "input",
    "run",
    "result",
    "selection",
    "terminal",
    "createdAt",
    "updatedAt",
    "contentDigest",
  ]);
  if (v.schemaVersion !== "crewon.project-text-plan-step.v1") planFailure();
  const kind = planStage(v.kind),
    episodeId = planNullable(v.episodeId, planId),
    state = planEnum(v.state, [
      "ready",
      "admitted",
      "waitingSelection",
      "succeeded",
      "paused",
      "failed",
      "revoked",
    ]),
    sources = planNullable(v.sources, planSources),
    baseline = planNullable(v.baseline, parseProjectTextPlanBaseline);
  const inputValue = planNullable(v.input, (entry) => {
    const x = planRecord(entry, [
      "content",
      "idempotencyKey",
      "expectedThreadRevision",
    ]);
    if (
      typeof x.content !== "string" ||
      x.content.trim().length === 0 ||
      new TextEncoder().encode(x.content).length > 9999 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(
        x.content,
      )
    )
      planFailure();
    return Object.freeze({
      content: x.content,
      idempotencyKey: planId(x.idempotencyKey),
      expectedThreadRevision: planRevision(x.expectedThreadRevision),
    });
  });
  const run = planNullable(v.run, (entry) => {
    const x = planRecord(entry, [
      "runId",
      "stageAdmissionDigest",
      "planAdmissionDigest",
    ]);
    return Object.freeze({
      runId: planId(x.runId),
      stageAdmissionDigest: planDigest(x.stageAdmissionDigest),
      planAdmissionDigest: planDigest(x.planAdmissionDigest),
    });
  });
  const result = planNullable(v.result, parseProjectTextPlanResultReference),
    selection = planNullable(
      v.selection,
      parseProjectTextPlanSelectionReference,
    );
  const terminal = planNullable(v.terminal, (entry) => {
    const x = planRecord(entry, [
      "eventId",
      "throughSequence",
      "runRevision",
      "status",
    ]);
    return Object.freeze({
      eventId: planId(x.eventId),
      throughSequence: planRevision(x.throughSequence),
      runRevision: planRevision(x.runRevision),
      status: planEnum(x.status, ["completed", "failed", "canceled"]),
    });
  });
  if (
    (kind === "script") !== (episodeId !== null) ||
    (run === null) !== (inputValue === null) ||
    (run !== null && sources === null) ||
    (result !== null &&
      (result.kind !== kind || result.runId !== run?.runId)) ||
    (selection !== null &&
      (result === null ||
        result.kind === "brief" ||
        selection.artifactId !== result.artifactId ||
        selection.contentRevision !== result.contentRevision ||
        selection.contentDigest !== result.contentDigest)) ||
    (terminal !== null && run === null) ||
    (state === "admitted" && run === null) ||
    (state === "waitingSelection" &&
      (result === null || terminal?.status !== "completed")) ||
    (state === "succeeded" &&
      (result === null ||
        terminal?.status !== "completed" ||
        (kind !== "brief" && selection === null))) ||
    (baseline !== null &&
      (baseline.kind !== kind || baseline.episodeId !== episodeId))
  )
    planFailure();
  return planChecked(
    {
      schemaVersion: v.schemaVersion,
      planId: planId(v.planId),
      planRevision: planRevision(v.planRevision),
      stepId: planId(v.stepId),
      ordinal: planInteger(v.ordinal, 1, 18),
      kind,
      episodeId,
      attempt: planRevision(v.attempt),
      revision: planRevision(v.revision),
      state,
      sources,
      baseline,
      input: inputValue,
      run,
      result,
      selection,
      terminal,
      ...planTimes(v.createdAt, v.updatedAt),
    },
    v.contentDigest,
    digester,
  );
}
export function createProjectTextPlanStep(
  input: Omit<ProjectTextPlanStep, "schemaVersion" | "contentDigest">,
  digester: ExtensionContentDigester,
): ProjectTextPlanStep {
  return parseProjectTextPlanStep(
    planCreated(
      { schemaVersion: "crewon.project-text-plan-step.v1", ...input },
      digester,
    ),
    digester,
  );
}
export function assertProjectTextPlanStepChange(
  previous: ProjectTextPlanStep,
  next: ProjectTextPlanStep,
): void {
  if (
    next.revision !== previous.revision + 1 ||
    next.attempt !== previous.attempt ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)
  )
    planFailure("project_text_plan_step_transition_invalid");
  for (const key of [
    "planId",
    "planRevision",
    "stepId",
    "ordinal",
    "kind",
    "episodeId",
    "createdAt",
  ] as const)
    if (next[key] !== previous[key])
      planFailure("project_text_plan_step_identity_changed");
  for (const key of [
    "input",
    "sources",
    "baseline",
    "run",
    "result",
    "selection",
    "terminal",
  ] as const)
    if (
      previous[key] !== null &&
      JSON.stringify(previous[key]) !== JSON.stringify(next[key])
    )
      planFailure("project_text_plan_step_evidence_changed");
}
