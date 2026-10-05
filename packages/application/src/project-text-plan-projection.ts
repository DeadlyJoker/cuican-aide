import type {
  ProjectTextPlan,
  ProjectTextPlanRevision,
  ProjectTextPlanStep,
} from "@crewon/domain";
import type {
  PublicProjectTextPlanSummary,
  PublicProjectTextPlanView,
  PublicProjectTextPlanSources,
} from "@crewon/contracts/project-text-plans";
export function projectTextPlanSummary(
  p: ProjectTextPlan,
): PublicProjectTextPlanSummary {
  return Object.freeze({
    planId: p.planId,
    projectId: p.projectId,
    threadId: p.threadId,
    revision: p.revision,
    currentPlanRevision: p.currentPlanRevision,
    state: p.state,
    activeStepId: p.activeStepId,
    pauseReason: p.pauseReason,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });
}
export function projectTextPlanView(
  plan: ProjectTextPlan,
  definition: ProjectTextPlanRevision,
  steps: readonly ProjectTextPlanStep[],
): PublicProjectTextPlanView {
  if (
    definition.planId !== plan.planId ||
    definition.planRevision !== plan.currentPlanRevision ||
    steps.length > 18 ||
    steps.some(
      (x) =>
        x.planId !== plan.planId || x.planRevision !== definition.planRevision,
    ) ||
    definition.sources.brief === null
  )
    throw new Error("project_text_plan_store_result_invalid");
  return Object.freeze({
    plan: projectTextPlanSummary(plan),
    definition: Object.freeze({
      planId: definition.planId,
      planRevision: definition.planRevision,
      start: definition.start,
      target: definition.targetStage,
      episodeMode: definition.episodeMode,
      episodeIds: definition.episodeIds,
      adoption: definition.adoption,
      instruction: definition.instruction,
      sources: definition.sources as PublicProjectTextPlanSources,
    }),
    steps: Object.freeze(
      steps.map((s) =>
        Object.freeze({
          stepId: s.stepId,
          ordinal: s.ordinal,
          kind: s.kind,
          episodeId: s.episodeId,
          attempt: s.attempt,
          revision: s.revision,
          state: s.state,
          sources: s.sources as PublicProjectTextPlanSources | null,
          run:
            s.run === null
              ? null
              : Object.freeze({
                  runId: s.run.runId,
                  stageAdmissionDigest: s.run.stageAdmissionDigest,
                }),
          result:
            s.result === null
              ? null
              : Object.freeze({
                  kind: s.result.kind,
                  briefRevision: s.result.briefRevision,
                  artifactId: s.result.artifactId,
                  artifactRevision: s.result.artifactRevision,
                  contentRevision: s.result.contentRevision,
                  contentDigest: s.result.contentDigest,
                }),
          selection:
            s.selection === null
              ? null
              : Object.freeze({
                  mode: s.selection.mode,
                  artifactId: s.selection.artifactId,
                  artifactRevision: s.selection.artifactRevision,
                  contentRevision: s.selection.contentRevision,
                  contentDigest: s.selection.contentDigest,
                }),
          terminal:
            s.terminal === null
              ? null
              : Object.freeze({
                  status: s.terminal.status,
                  runRevision: s.terminal.runRevision,
                  throughSequence: s.terminal.throughSequence,
                }),
        }),
      ),
    ),
  });
}
