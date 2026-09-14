import type { CanonicalAgentEvent } from "@crewon/contracts";
import type { RunLifecycleEvent, RunState } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { DomainStore } from "./domain-store-port.ts";

/** Provider response retrieval may replay an image in a new segment/attempt. */
export async function findImageEventReplay(
  store: Pick<DomainStore, "listRunEvents">,
  state: Pick<RunState, "tenantId" | "runId" | "lastSequence">,
  incoming: CanonicalAgentEvent,
): Promise<RunLifecycleEvent | null> {
  if (
    incoming.type !== "model.image.progress" &&
    incoming.type !== "model.image.generated"
  )
    return null;
  let cursor = 0;
  let replay: RunLifecycleEvent | null = null;
  const stages = ["in_progress", "generating", "completed"];
  while (cursor < state.lastSequence) {
    const page = await store.listRunEvents(
      { tenantId: state.tenantId, runId: state.runId },
      cursor,
      Math.min(100, state.lastSequence - cursor),
    );
    if (page.length === 0 || page.at(-1)!.sequence <= cursor)
      throw new ApplicationError("internal", "run_event_history_incomplete");
    for (const event of page) {
      if (
        (event.type !== "model.image.generated" &&
          event.type !== "model.image.progress") ||
        event.data.itemId !== incoming.data.itemId
      )
        continue;
      if (incoming.type === "model.image.progress") {
        if (
          event.type === "model.image.generated" ||
          stages.indexOf(event.data.stage) >=
            stages.indexOf(String(incoming.data.stage))
        )
          replay = event;
      } else if (event.type === "model.image.generated") {
        if (
          event.data.artifactRef !== incoming.data.artifactRef ||
          event.data.mimeType !== incoming.data.mimeType ||
          event.data.byteLength !== incoming.data.byteLength
        )
          throw new ApplicationError("conflict", "model_image_output_conflict");
        replay = event;
      }
    }
    cursor = page.at(-1)!.sequence;
  }
  return replay;
}
