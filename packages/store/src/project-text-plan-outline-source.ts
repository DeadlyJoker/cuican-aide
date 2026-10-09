import {
  ProjectTextError,
  type ProjectOutlineSourceRevision,
} from "@crewon/domain";
import { assertOutlineSourceInputsCurrent } from "./project-outline-source-store-support.ts";
import type { ProjectFoundationDownstreamSnapshot } from "./project-foundation-downstream-guard.ts";
import { planStoreFail } from "./project-text-plan-records.ts";

/** Preserve the existing actionable plan conflict; corrupt storage remains an internal failure. */
export function assertPlanOutlineInputsCurrent(
  source: ProjectOutlineSourceRevision | null,
  snapshot: ProjectFoundationDownstreamSnapshot,
): void {
  try {
    assertOutlineSourceInputsCurrent(source, snapshot);
  } catch (error) {
    if (
      error instanceof ProjectTextError &&
      error.code === "project_outline_inputs_stale"
    )
      planStoreFail("project_text_plan_source_changed");
    throw error;
  }
}
