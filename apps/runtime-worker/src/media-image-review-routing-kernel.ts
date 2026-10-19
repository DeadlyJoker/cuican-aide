import { types } from "node:util";
import {
  AgentKernelError,
  CrewONAgentKernel,
  type AgentKernelPort,
  type AgentSegmentContract,
  type AgentSegmentRunOptions,
  type KernelAgentEvent,
} from "@crewon/agent-kernel";
import {
  mediaInputActor,
  type ActorContext,
  type RunRoute,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { MediaImageReviewKernel } from "./media-image-review-kernel.ts";
import { MediaImageReviewSourceReader } from "./media-image-review-source.ts";

export type SavedImageReviewRuntimePurpose = Readonly<{
  kind: "saved-image-review";
  store: SqliteRunStore;
  sources: MediaImageReviewSourceReader;
  actor: ActorContext;
}>;
export function captureSavedImageReviewRuntimePurpose(
  value: SavedImageReviewRuntimePurpose,
): SavedImageReviewRuntimePurpose {
  if (
    !value ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("configuration_invalid");
  const ds = Object.getOwnPropertyDescriptors(value);
  const expected = ["kind", "store", "sources", "actor"];
  if (
    Reflect.ownKeys(ds).length !== expected.length ||
    expected.some((k) => !ds[k] || !Object.hasOwn(ds[k], "value"))
  )
    fail("configuration_invalid");
  const store = ds.store!.value,
    sources = ds.sources!.value;
  if (
    ds.kind!.value !== "saved-image-review" ||
    !(store instanceof SqliteRunStore) ||
    types.isProxy(store) ||
    !(sources instanceof MediaImageReviewSourceReader) ||
    types.isProxy(sources)
  )
    fail("configuration_invalid");
  return Object.freeze({
    kind: "saved-image-review",
    store,
    sources,
    actor: mediaInputActor(ds.actor!.value),
  });
}

/** One pinned reviewer runtime routes multiple real Runs by original SQL admission, never report JSON. */
export class MediaImageReviewRoutingKernel implements AgentKernelPort {
  readonly modelIdentity: AgentKernelPort["modelIdentity"];
  readonly maxOutputTokens: number | undefined;
  readonly #kernel: CrewONAgentKernel;
  readonly #purpose: SavedImageReviewRuntimePurpose;
  readonly #route: RunRoute;
  readonly #closing = new AbortController();
  readonly #pending = new Set<Promise<void>>();
  #closed = false;
  constructor(
    input: Readonly<{
      kernel: CrewONAgentKernel;
      purpose: SavedImageReviewRuntimePurpose;
      route: RunRoute;
    }>,
  ) {
    if (
      !(input.kernel instanceof CrewONAgentKernel) ||
      types.isProxy(input.kernel) ||
      input.route.workspaceBindingId !== null
    )
      fail("configuration_invalid");
    this.#kernel = input.kernel;
    this.#purpose = captureSavedImageReviewRuntimePurpose(input.purpose);
    this.#route = Object.freeze({ ...input.route });
    this.modelIdentity = input.kernel.modelIdentity;
    this.maxOutputTokens = input.kernel.maxOutputTokens;
  }
  matchesRunStore(run: RunState, store: SqliteRunStore): boolean {
    const actor = this.#purpose.actor,
      route = this.#route;
    return (
      !this.#closed &&
      store === this.#purpose.store &&
      run.tenantId === actor.tenantId &&
      run.spaceId === actor.spaceId &&
      run.createdByActorId === actor.actorId &&
      run.agentVersionId === route.agentVersionId &&
      run.authorityId === route.authorityId &&
      run.runtimeGeneration === route.runtimeGeneration &&
      run.policySnapshotId === route.policySnapshotId &&
      run.workspaceBindingId === null
    );
  }
  async *runSegment(
    contract: AgentSegmentContract,
    signal: AbortSignal,
    options?: AgentSegmentRunOptions,
  ): AsyncIterable<KernelAgentEvent> {
    if (this.#closed) fail("closed");
    if (
      contract.agentVersionId !== this.#route.agentVersionId ||
      contract.policySnapshotId !== this.#route.policySnapshotId ||
      contract.purpose !== "agent"
    )
      fail("route_mismatch");
    const combined = AbortSignal.any([signal, this.#closing.signal]);
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#pending.add(pending);
    try {
      const actor = this.#purpose.actor;
      const run = await SqliteRunStore.prototype.loadRunInSpace.call(
        this.#purpose.store,
        {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          runId: contract.runId,
        },
      );
      combined.throwIfAborted();
      if (!run || !this.matchesRunStore(run, this.#purpose.store))
        fail("route_mismatch");
      const review = await MediaImageReviewKernel.restore({
        kernel: this.#kernel,
        sources: this.#purpose.sources,
        store: this.#purpose.store,
        scope: {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          runId: contract.runId,
        },
        signal: combined,
      });
      yield* MediaImageReviewKernel.prototype.runSegment.call(
        review,
        contract,
        combined,
        options,
      );
    } catch (cause) {
      if (cause instanceof AgentKernelError) throw cause;
      throw new AgentKernelError(
        combined.aborted
          ? "segment_canceled"
          : "media_image_review_routing_unavailable",
        false,
        { cause },
      );
    } finally {
      this.#pending.delete(pending);
      settle();
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#closing.abort();
    await Promise.allSettled([...this.#pending]);
  }
}
function fail(code: string): never {
  throw new AgentKernelError(`media_image_review_routing_${code}`, false);
}
