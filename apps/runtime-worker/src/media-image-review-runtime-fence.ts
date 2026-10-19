import { types } from "node:util";
import { AgentKernelError, type AgentKernelPort } from "@crewon/agent-kernel";
import {
  SqliteRunStore,
  SqliteProjectMediaImageReviewJobStore,
} from "@crewon/store";
import type { RunState } from "@crewon/domain";
import type { DomainStore } from "@crewon/application";
import { MediaImageReviewKernel } from "./media-image-review-kernel.ts";
import { MediaImageReviewRoutingKernel } from "./media-image-review-routing-kernel.ts";

/** Never dispatch a saved-image job through an ordinary text/provider Kernel. */
export function mediaImageReviewRuntimeFence(store: DomainStore) {
  if (!(store instanceof SqliteRunStore))
    return async (_run: RunState, _kernel: AgentKernelPort) => {};
  if (types.isProxy(store))
    throw new AgentKernelError(
      "media_image_review_original_store_required",
      false,
    );
  const jobs =
    SqliteRunStore.prototype.projectMediaImageReviewJobStore.call(store);
  return async (run: RunState, kernel: AgentKernelPort): Promise<void> => {
    try {
      const job =
        await SqliteProjectMediaImageReviewJobStore.prototype.loadIfAvailable.call(
          jobs,
          { tenantId: run.tenantId, spaceId: run.spaceId, runId: run.runId },
        );
      if (job === null) return;
      const matched =
        !types.isProxy(kernel) &&
        (kernel instanceof MediaImageReviewKernel
          ? MediaImageReviewKernel.prototype.matchesRunStore.call(
              kernel,
              run,
              store,
            )
          : kernel instanceof MediaImageReviewRoutingKernel
            ? MediaImageReviewRoutingKernel.prototype.matchesRunStore.call(
                kernel,
                run,
                store,
              )
            : false);
      if (!matched)
        throw new AgentKernelError(
          "media_image_review_runtime_required",
          false,
        );
    } catch (cause) {
      if (cause instanceof AgentKernelError) throw cause;
      throw new AgentKernelError(
        "media_image_review_runtime_admission_unavailable",
        false,
        { cause },
      );
    }
  };
}
