import {
  extensionCanonicalJson,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import {
  createProjectTextPlan,
  assertProjectTextPlanChange,
} from "./project-text-plan.ts";
import {
  createProjectTextPlanStep,
  assertProjectTextPlanStepChange,
} from "./project-text-plan-step.ts";
import type {
  ProjectTextPlan,
  ProjectTextPlanRevision,
  ProjectTextPlanStep,
  ProjectTextPlanRunAdmission,
  ProjectTextPlanResultReference,
  ProjectTextPlanSelectionReference,
} from "./project-text-plan-types.ts";
import { planFailure, planTime } from "./project-text-plan-validation.ts";

type Checkpoint = Readonly<{
  plan: ProjectTextPlan;
  step: ProjectTextPlanStep;
}>;
export function projectTextPlanStepKinds(
  definition: ProjectTextPlanRevision,
): readonly Readonly<{
  kind: ProjectTextPlanStep["kind"];
  episodeId: string | null;
}>[] {
  const steps: Readonly<{
    kind: ProjectTextPlanStep["kind"];
    episodeId: string | null;
  }>[] = [];
  if (definition.start === "brief")
    steps.push({ kind: "brief", episodeId: null });
  if (definition.start !== "script" && definition.targetStage !== "brief")
    steps.push({ kind: "outline", episodeId: null });
  if (definition.targetStage === "script")
    for (const episodeId of definition.episodeIds)
      steps.push({ kind: "script", episodeId });
  if (steps.length === 0 || steps.length > 18) planFailure();
  return Object.freeze(steps.map((x) => Object.freeze(x)));
}
export function createProjectTextPlanSteps(
  definition: ProjectTextPlanRevision,
  stepIds: readonly string[],
  at: string,
  digester: ExtensionContentDigester,
): readonly ProjectTextPlanStep[] {
  const kinds = projectTextPlanStepKinds(definition);
  if (
    stepIds.length !== kinds.length ||
    new Set(stepIds).size !== stepIds.length
  )
    planFailure("project_text_plan_steps_invalid");
  return Object.freeze(
    kinds.map((item, i) =>
      createProjectTextPlanStep(
        {
          planId: definition.planId,
          planRevision: definition.planRevision,
          stepId: stepIds[i]!,
          ordinal: i + 1,
          ...item,
          attempt: 1,
          revision: 1,
          state: "ready",
          sources: null,
          baseline: null,
          input: null,
          run: null,
          result: null,
          selection: null,
          terminal: null,
          createdAt: at,
          updatedAt: at,
        },
        digester,
      ),
    ),
  );
}
export function createProjectTextPlanRemainingSteps(
  definition: ProjectTextPlanRevision,
  previousSteps: readonly ProjectTextPlanStep[],
  stepIds: readonly string[],
  at: string,
  digester: ExtensionContentDigester,
): readonly ProjectTextPlanStep[] {
  const kinds = projectTextPlanStepKinds(definition).filter(
    (item) =>
      !previousSteps.some(
        (step) =>
          step.kind === item.kind &&
          step.episodeId === item.episodeId &&
          step.state === "succeeded",
      ),
  );
  if (
    kinds.length === 0 ||
    stepIds.length !== kinds.length ||
    new Set(stepIds).size !== stepIds.length ||
    stepIds.some((id) => previousSteps.some((step) => step.stepId === id))
  )
    planFailure("project_text_plan_remaining_steps_invalid");
  return Object.freeze(
    kinds.map((item, i) => {
      const prior = previousSteps.find(
        (step) => step.kind === item.kind && step.episodeId === item.episodeId,
      );
      return createProjectTextPlanStep(
        {
          planId: definition.planId,
          planRevision: definition.planRevision,
          stepId: stepIds[i]!,
          ordinal: i + 1,
          ...item,
          attempt:
            prior === undefined
              ? 1
              : prior.attempt + (prior.run === null ? 0 : 1),
          revision: 1,
          state: "ready",
          sources: null,
          baseline: null,
          input: null,
          run: null,
          result: null,
          selection: null,
          terminal: null,
          createdAt: at,
          updatedAt: at,
        },
        digester,
      );
    }),
  );
}
/** Pure recipe; the Store first verifies the actual binding, source/delegation and selected rows. */
export function applyProjectTextPlanControl(
  input: Readonly<{
    kind:
      | "start"
      | "pause"
      | "revoke"
      | "resume"
      | "reviseRemaining"
      | "continue";
    previous: ProjectTextPlan | null;
    previousRevision: ProjectTextPlanRevision | null;
    previousSteps: readonly ProjectTextPlanStep[];
    definition: ProjectTextPlanRevision;
    stepIds: readonly string[];
    at: string;
    authorizationUnavailable?: boolean;
  }>,
  digester: ExtensionContentDigester,
): Readonly<{ plan: ProjectTextPlan; steps: readonly ProjectTextPlanStep[] }> {
  const { previous: old, definition: d, kind } = input,
    at = planTime(input.at);
  if (kind === "start") {
    if (
      old !== null ||
      input.previousRevision !== null ||
      input.previousSteps.length !== 0 ||
      d.planRevision !== 1 ||
      d.delegation.actionId !== "crewon.project-text-plans.v1.start"
    )
      planFailure("project_text_plan_transition_invalid");
    const steps = createProjectTextPlanSteps(d, input.stepIds, at, digester);
    return Object.freeze({
      plan: createProjectTextPlan(
        {
          planId: d.planId,
          owner: d.actor,
          profileId: d.installation.profileId,
          projectId: d.projectId,
          threadId: d.threadId,
          bindingId: d.bindingId,
          workspaceId: d.workspaceId,
          revision: 1,
          currentPlanRevision: 1,
          state: input.authorizationUnavailable ? "paused" : "ready",
          activeStepId: steps[0]!.stepId,
          pauseReason: input.authorizationUnavailable
            ? "authorization_unavailable"
            : null,
          wakeRevision: 1,
          createdAt: at,
          updatedAt: at,
        },
        digester,
      ),
      steps,
    });
  }
  if (
    old === null ||
    input.previousRevision === null ||
    old.state === "revoked" ||
    old.planId !== d.planId
  )
    planFailure("project_text_plan_transition_invalid");
  const previousRevision = input.previousRevision;
  assertIdentity(old, d);
  let state: ProjectTextPlan["state"] = old.state,
    activeStepId = old.activeStepId,
    pauseReason: ProjectTextPlan["pauseReason"] = null,
    wakeRevision = old.wakeRevision,
    currentPlanRevision = old.currentPlanRevision,
    steps = input.previousSteps;
  if (kind === "pause" || kind === "revoke") {
    if (
      extensionCanonicalJson(d) !== extensionCanonicalJson(previousRevision) ||
      old.state === "completed"
    )
      planFailure("project_text_plan_transition_invalid");
    state = kind === "pause" ? "paused" : "revoked";
    pauseReason = kind === "pause" ? "user_paused" : null;
  } else if (kind === "resume" || kind === "reviseRemaining") {
    const active = steps.find((x) => x.stepId === old.activeStepId);
    if (old.state !== "paused" && old.state !== "waitingSelection")
      planFailure("project_text_plan_transition_invalid");
    if (
      active?.run !== null &&
      active?.run !== undefined &&
      active.terminal === null
    )
      planFailure("project_text_plan_run_still_active");
    if (
      d.planRevision !== old.currentPlanRevision + 1 ||
      d.delegation.actionId !== `crewon.project-text-plans.v1.${kind}`
    )
      planFailure("project_text_plan_transition_invalid");
    const unfinished = steps.filter((x) => x.state !== "succeeded");
    const order = ["brief", "outline", "script"];
    if (
      unfinished.length === 0 ||
      order.indexOf(d.start) < order.indexOf(unfinished[0]!.kind)
    )
      planFailure("project_text_plan_remaining_scope_invalid");
    if (
      kind === "resume" &&
      (d.adoption !== previousRevision.adoption ||
        d.targetStage !== previousRevision.targetStage ||
        d.episodeIds.some((id) => !previousRevision.episodeIds.includes(id)) ||
        (previousRevision.episodeMode === "independentScripts" &&
          d.episodeMode !== "independentScripts") ||
        d.instruction !== previousRevision.instruction)
    )
      planFailure("project_text_plan_resume_scope_changed");
    steps = createProjectTextPlanRemainingSteps(
      d,
      input.previousSteps,
      input.stepIds,
      at,
      digester,
    );
    currentPlanRevision = d.planRevision;
    state = input.authorizationUnavailable ? "paused" : "ready";
    pauseReason = input.authorizationUnavailable
      ? "authorization_unavailable"
      : null;
    activeStepId = steps[0]!.stepId;
    wakeRevision++;
  } else {
    if (
      extensionCanonicalJson(d) !== extensionCanonicalJson(previousRevision) ||
      !["waitingSelection", "paused"].includes(old.state)
    )
      planFailure("project_text_plan_transition_invalid");
    const step = steps.find((x) => x.stepId === old.activeStepId);
    if (
      step === undefined ||
      step.terminal?.status !== "completed" ||
      step.result === null ||
      step.kind === "brief" ||
      step.selection === null ||
      step.selection.artifactId !== step.result.artifactId ||
      step.selection.contentRevision !== step.result.contentRevision ||
      step.selection.contentDigest !== step.result.contentDigest
    )
      planFailure("project_text_plan_selection_required");
    const changed = updateStep(step, { state: "succeeded" }, at, digester);
    steps = Object.freeze(
      steps.map((x) => (x.stepId === step.stepId ? changed : x)),
    );
    const next = steps.find(
      (x) => x.ordinal > step.ordinal && x.state === "ready",
    );
    activeStepId = next?.stepId ?? null;
    state = next === undefined ? "completed" : "ready";
    if (next !== undefined) wakeRevision++;
  }
  const plan = updatePlan(
    old,
    { state, activeStepId, pauseReason, wakeRevision, currentPlanRevision },
    at,
    digester,
  );
  return Object.freeze({ plan, steps });
}
export function checkpointProjectTextPlanAdmission(
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  admission: ProjectTextPlanRunAdmission,
  content: string,
  expectedThreadRevision: number,
  at: string,
  digester: ExtensionContentDigester,
): Checkpoint {
  if (
    plan.state !== "ready" ||
    plan.activeStepId !== step.stepId ||
    step.state !== "ready" ||
    step.run !== null ||
    plan.currentPlanRevision !== step.planRevision ||
    admission.stepId !== step.stepId ||
    admission.stepRevision !== step.revision
  )
    planFailure("project_text_plan_step_unavailable");
  const changed = updateStep(
    step,
    {
      state: "admitted",
      sources: admission.sources,
      baseline: admission.baseline,
      input: {
        content,
        idempotencyKey: admission.taskIdempotencyKey,
        expectedThreadRevision,
      },
      run: {
        runId: admission.runId,
        stageAdmissionDigest: admission.stageAdmissionDigest,
        planAdmissionDigest: admission.contentDigest,
      },
    },
    at,
    digester,
  );
  return Object.freeze({
    plan: updatePlan(plan, { state: "running" }, at, digester),
    step: changed,
  });
}
export function checkpointProjectTextPlanResult(
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  result: ProjectTextPlanResultReference,
  at: string,
  digester: ExtensionContentDigester,
): Checkpoint {
  if (
    plan.state === "revoked" ||
    step.run?.runId !== result.runId ||
    step.kind !== result.kind
  )
    planFailure("project_text_plan_result_not_authorized");
  if (step.result !== null) {
    if (extensionCanonicalJson(step.result) !== extensionCanonicalJson(result))
      planFailure("project_text_plan_result_limit");
    return Object.freeze({ plan, step });
  }
  return Object.freeze({
    plan,
    step: updateStep(step, { result }, at, digester),
  });
}
export function checkpointProjectTextPlanTerminal(
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  terminal: NonNullable<ProjectTextPlanStep["terminal"]>,
  steps: readonly ProjectTextPlanStep[],
  at: string,
  digester: ExtensionContentDigester,
): Checkpoint {
  if (step.run === null || plan.activeStepId !== step.stepId)
    planFailure("project_text_plan_run_scope_invalid");
  if (step.terminal !== null) {
    if (
      extensionCanonicalJson(step.terminal) !== extensionCanonicalJson(terminal)
    )
      planFailure("project_text_plan_terminal_changed");
    return Object.freeze({ plan, step });
  }
  let state: ProjectTextPlan["state"] = plan.state,
    stepState: ProjectTextPlanStep["state"] = step.state,
    pauseReason = plan.pauseReason,
    activeStepId: string | null = plan.activeStepId,
    wakeRevision = plan.wakeRevision;
  if (state !== "revoked" && state !== "paused") {
    if (terminal.status !== "completed" || step.result === null) {
      state = "paused";
      stepState = "failed";
      pauseReason =
        terminal.status === "failed"
          ? "run_failed"
          : terminal.status === "canceled"
            ? "run_canceled"
            : "result_missing";
    } else if (step.kind === "brief") {
      stepState = "succeeded";
      const next = steps.find(
        (x) =>
          x.planRevision === step.planRevision &&
          x.ordinal > step.ordinal &&
          x.state === "ready",
      );
      activeStepId = next?.stepId ?? null;
      state = next === undefined ? "completed" : "ready";
      if (next !== undefined) wakeRevision++;
    } else {
      stepState = "waitingSelection";
      state = "waitingSelection";
    }
  } else if (terminal.status === "completed" && step.result !== null) {
    stepState = step.kind === "brief" ? "succeeded" : "waitingSelection";
    if (
      state === "paused" &&
      step.kind === "brief" &&
      !steps.some(
        (x) =>
          x.planRevision === step.planRevision &&
          x.ordinal > step.ordinal &&
          x.state === "ready",
      )
    ) {
      state = "completed";
      pauseReason = null;
      activeStepId = null;
    }
  }
  return Object.freeze({
    plan: updatePlan(
      plan,
      { state, pauseReason, activeStepId, wakeRevision },
      at,
      digester,
    ),
    step: updateStep(step, { terminal, state: stepState }, at, digester),
  });
}
/** A manual selection only records the confirmed receipt; Continue remains explicit. */
export function checkpointProjectTextPlanSelection(
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  selection: ProjectTextPlanSelectionReference,
  at: string,
  digester: ExtensionContentDigester,
): Checkpoint {
  const result = step.result;
  if (
    plan.state === "revoked" ||
    result === null ||
    result.kind === "brief" ||
    selection.artifactId !== result.artifactId ||
    selection.contentRevision !== result.contentRevision ||
    selection.contentDigest !== result.contentDigest
  )
    planFailure("project_text_plan_selection_scope_invalid");
  if (step.selection !== null) {
    if (
      extensionCanonicalJson(step.selection) !==
      extensionCanonicalJson(selection)
    )
      planFailure("project_text_plan_selection_changed");
    return Object.freeze({ plan, step });
  }
  return Object.freeze({
    plan,
    step: updateStep(step, { selection }, at, digester),
  });
}
/** Used only after the independent whenUnchanged authority and actual baseline checks. */
export function advanceProjectTextPlanSelection(
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  selection: ProjectTextPlanSelectionReference,
  steps: readonly ProjectTextPlanStep[],
  at: string,
  digester: ExtensionContentDigester,
): Checkpoint {
  if (
    selection.mode !== "whenUnchanged" ||
    plan.state !== "waitingSelection" ||
    step.state !== "waitingSelection" ||
    step.terminal?.status !== "completed"
  )
    planFailure("project_text_plan_auto_selection_unavailable");
  const checkpoint = checkpointProjectTextPlanSelection(
      plan,
      step,
      selection,
      at,
      digester,
    ),
    changed = updateStep(
      step,
      { selection: checkpoint.step.selection, state: "succeeded" },
      at,
      digester,
    ),
    next = steps.find(
      (x) =>
        x.planRevision === step.planRevision &&
        x.ordinal > step.ordinal &&
        x.state === "ready",
    );
  return Object.freeze({
    plan: updatePlan(
      plan,
      {
        state: next === undefined ? "completed" : "ready",
        activeStepId: next?.stepId ?? null,
        wakeRevision: plan.wakeRevision + (next === undefined ? 0 : 1),
      },
      at,
      digester,
    ),
    step: changed,
  });
}
export function assertProjectTextPlanOutlineEpisodes(
  admission: ProjectTextPlanRunAdmission,
  episodeIds: readonly string[],
): void {
  if (
    admission.kind !== "outline" ||
    extensionCanonicalJson(episodeIds) !==
      extensionCanonicalJson(admission.expectedEpisodeIds)
  )
    planFailure("project_text_plan_outline_episodes_invalid");
}
function assertIdentity(
  plan: ProjectTextPlan,
  d: ProjectTextPlanRevision,
): void {
  for (const key of [
    "projectId",
    "threadId",
    "bindingId",
    "workspaceId",
  ] as const)
    if (plan[key] !== d[key]) planFailure("project_text_plan_identity_changed");
  if (
    plan.profileId !== d.installation.profileId ||
    extensionCanonicalJson(plan.owner) !== extensionCanonicalJson(d.actor)
  )
    planFailure("project_text_plan_identity_changed");
}
function updatePlan(
  plan: ProjectTextPlan,
  patch: Partial<ProjectTextPlan>,
  at: string,
  digester: ExtensionContentDigester,
): ProjectTextPlan {
  const { schemaVersion: _, contentDigest: __, ...body } = plan;
  const next = createProjectTextPlan(
    { ...body, ...patch, revision: plan.revision + 1, updatedAt: at },
    digester,
  );
  assertProjectTextPlanChange(plan, next);
  return next;
}
function updateStep(
  step: ProjectTextPlanStep,
  patch: Partial<ProjectTextPlanStep>,
  at: string,
  digester: ExtensionContentDigester,
): ProjectTextPlanStep {
  const { schemaVersion: _, contentDigest: __, ...body } = step;
  const next = createProjectTextPlanStep(
    { ...body, ...patch, revision: step.revision + 1, updatedAt: at },
    digester,
  );
  assertProjectTextPlanStepChange(step, next);
  return next;
}

/** A real current metadata owner may annotate why a remaining slot cannot proceed. */
export function checkpointProjectTextPlanSystemPause(
  plan: ProjectTextPlan,
  step: ProjectTextPlanStep,
  reason: Exclude<NonNullable<ProjectTextPlan["pauseReason"]>, "user_paused">,
  at: string,
  digester: ExtensionContentDigester,
): Checkpoint {
  if (
    plan.state === "revoked" ||
    plan.state === "completed" ||
    plan.activeStepId !== step.stepId ||
    step.planId !== plan.planId ||
    step.planRevision !== plan.currentPlanRevision
  )
    planFailure("project_text_plan_pause_unavailable");
  if (plan.state === "paused" && plan.pauseReason === reason)
    return Object.freeze({ plan, step });
  return Object.freeze({
    plan: updatePlan(
      plan,
      { state: "paused", pauseReason: reason },
      at,
      digester,
    ),
    step,
  });
}
