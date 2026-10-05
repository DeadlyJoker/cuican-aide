import {
  extensionCanonicalJson,
  type ProjectTextPlanRevision,
  type ProjectTextPlanStep,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";

/** Resume cannot silently adopt a different outline; that change requires reviseRemaining. */
export function assertProjectTextPlanResumeSources(
  previous: ProjectTextPlanRevision,
  steps: readonly ProjectTextPlanStep[],
  next: ProjectTextPlanRevision,
): void {
  if (next.start !== "script" || previous.episodeMode === "independentScripts")
    return;
  const result = steps.find(
    (s) => s.kind === "outline" && s.state === "succeeded",
  )?.result;
  const expected =
    result?.kind === "outline"
      ? {
          artifactId: result.artifactId,
          contentRevision: result.contentRevision,
          contentDigest: result.contentDigest,
        }
      : previous.sources.outline;
  if (
    expected === null ||
    extensionCanonicalJson(expected) !==
      extensionCanonicalJson(next.sources.outline)
  )
    throw new ApplicationError("conflict", "project_text_plan_source_changed");
}
