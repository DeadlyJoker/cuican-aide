import type {
  ProjectTextPlanRevision,
  ProjectTextPlanRunAdmission,
  ProjectTextPlanStep,
} from "@crewon/domain";
import { planEqual, planStoreFail } from "./project-text-plan-records.ts";

/** New admission freezes the original definition or this plan's earlier confirmed result, never a replacement source. */
export function assertPlanTurnSources(
  admission: ProjectTextPlanRunAdmission,
  definition: ProjectTextPlanRevision,
  step: ProjectTextPlanStep,
  steps: readonly ProjectTextPlanStep[],
): void {
  if (
    steps.length > 18 ||
    steps.some(
      (s) =>
        s.planId !== definition.planId ||
        s.planRevision !== definition.planRevision,
    )
  )
    planStoreFail();
  const prior = steps.filter(
      (s) => s.ordinal < step.ordinal && s.state === "succeeded",
    ),
    ownBrief = prior.find((s) => s.kind === "brief")?.result,
    brief =
      ownBrief?.kind === "brief"
        ? {
            briefRevision: ownBrief.briefRevision,
            contentDigest: ownBrief.contentDigest,
          }
        : definition.sources.brief;
  if (brief === null) planStoreFail("project_text_plan_source_changed");
  let outline = definition.sources.outline;
  if (step.kind !== "script" || definition.episodeMode === "independentScripts")
    outline = null;
  else {
    const previous = prior.find((s) => s.kind === "outline"),
      result = previous?.result;
    if (previous !== undefined) {
      if (
        result?.kind !== "outline" ||
        previous.selection === null ||
        previous.selection.artifactId !== result.artifactId ||
        previous.selection.contentRevision !== result.contentRevision ||
        previous.selection.contentDigest !== result.contentDigest
      )
        planStoreFail("project_text_plan_source_changed");
      outline = {
        artifactId: result.artifactId!,
        contentRevision: result.contentRevision!,
        contentDigest: result.contentDigest,
      };
    }
    if (outline === null) planStoreFail("project_text_plan_source_changed");
  }
  planEqual(
    admission.sources,
    { brief, outline },
    "project_text_plan_source_changed",
  );
}
