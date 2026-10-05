import type {
  ProjectGenerationHostContext,
  ProjectGenerationQueryHostContext,
  ProjectGenerationSelectionHostContext,
} from "@crewon/plugin-sdk/ui";
import type { ProjectHistoricalQueryHostContext } from "../plugin-project-historical-queries-service";
import type { ConceptGenerationLocator } from "@crewon/plugin-sdk/contracts";

export type ConceptRecoveryLane =
  | "generation"
  | "query"
  | "historicalQuery"
  | "selection";
export type ConceptRecoveryContexts = Readonly<{
  generation: ProjectGenerationHostContext | null;
  query: ProjectGenerationQueryHostContext | null;
  historicalQuery?: ProjectHistoricalQueryHostContext | null;
  selection: ProjectGenerationSelectionHostContext | null;
}>;
export type ConceptRecoveryChoice = Readonly<{
  lane: ConceptRecoveryLane;
  reference: ConceptGenerationLocator;
  phase: "pending" | "uncertain";
  retryable: boolean;
  selected: boolean;
}>;
const sourceKey = (source: ConceptGenerationLocator) =>
  JSON.stringify([source.projectId, source.assetId, source.assetRevision]);
const lanes = ["selection", "query", "historicalQuery", "generation"] as const;
function requestKey(request: unknown): string {
  const serialized = JSON.stringify(request);
  if (serialized === undefined)
    throw new Error("concept_recovery_request_invalid");
  return serialized;
}
type Selection = Readonly<{
  lane: ConceptRecoveryLane;
  request: string;
  source: string;
}>;
type Permit = Readonly<{
  source: string;
  epoch: number;
  decision: "adopt" | "history" | "conflict";
}>;

/** Capture all lane hints before any read can choose the single visible saved input. */
export class ConceptRecoveryCoordinator {
  #contexts: ConceptRecoveryContexts = {
    generation: null,
    query: null,
    historicalQuery: null,
    selection: null,
  };
  #source: string | null = null;
  #unresolved = false;
  #conflict = false;
  #manualHandling = false;
  #selection: Selection | null = null;
  #epoch = 0;
  readonly #permits = new Map<ConceptRecoveryLane, Permit>();
  get contexts() {
    return this.#contexts;
  }
  get conflict() {
    return this.#conflict;
  }
  get manualHandling() {
    return this.#manualHandling;
  }
  get selectedLane(): ConceptRecoveryLane | null {
    return this.#selection?.lane ?? null;
  }
  get choices(): readonly ConceptRecoveryChoice[] {
    return Object.freeze(
      lanes.flatMap((lane): ConceptRecoveryChoice[] => {
        const intent = this.#contexts[lane]?.intent;
        if (intent?.phase !== "pending" && intent?.phase !== "uncertain")
          return [];
        const { projectId, assetId, assetRevision } = intent.request.reference;
        return [
          Object.freeze({
            lane,
            reference: Object.freeze({ projectId, assetId, assetRevision }),
            phase: intent.phase,
            retryable: intent.retryable,
            selected: this.#selection?.lane === lane,
          }),
        ];
      }),
    );
  }
  /** A local choice permits reading one original source; it never changes an intent. */
  select(lane: ConceptRecoveryLane): boolean {
    const intent = this.#contexts[lane]?.intent;
    if (
      !this.#manualHandling ||
      (intent?.phase !== "pending" && intent?.phase !== "uncertain")
    )
      return false;
    this.#selection = Object.freeze({
      lane,
      request: requestKey(intent.request),
      source: sourceKey(intent.request.reference),
    });
    this.#source = this.#selection.source;
    ++this.#epoch;
    return true;
  }
  invalidateSelection(): void {
    this.#selection = null;
    if (this.#manualHandling) this.#source = null;
    ++this.#epoch;
  }
  allowsOriginalRetry(
    lane: ConceptRecoveryLane,
    source: ConceptGenerationLocator | null,
  ): boolean {
    const intent = this.#contexts[lane]?.intent;
    if (
      !source ||
      intent?.phase !== "uncertain" ||
      !intent.retryable ||
      sourceKey(intent.request.reference) !== sourceKey(source)
    )
      return false;
    if (!this.#manualHandling) return !this.#conflict;
    return Boolean(
      this.#selection?.lane === lane &&
        this.#selection.request === requestKey(intent.request) &&
        this.#selection.source === sourceKey(source),
    );
  }
  capture(input: ConceptRecoveryContexts): boolean {
    const contexts = Object.freeze({
      ...input,
      historicalQuery: input.historicalQuery ?? null,
    });
    const unresolved = lanes
      .map((lane) => contexts[lane]?.intent)
      .filter(
        (intent) =>
          intent?.phase === "pending" || intent?.phase === "uncertain",
      );
    const sources = new Set(
      unresolved.map((intent) => sourceKey(intent!.request.reference)),
    );
    const conflict = sources.size > 1;
    const manualHandling =
      unresolved.length > 0 && (this.#manualHandling || conflict);
    const invalidated = Boolean(
      this.#selection && requestKey(this.#contexts) !== requestKey(contexts),
    );
    if (invalidated) this.invalidateSelection();
    const first = lanes.map((lane) => contexts[lane]?.intent).find(Boolean);
    const nextSource = manualHandling
      ? (this.#selection?.source ?? null)
      : sources.size === 1
        ? [...sources][0]!
        : conflict || !first
          ? null
          : (this.#source ?? sourceKey(first.request.reference));
    const changed =
      invalidated ||
      this.#source !== nextSource ||
      this.#conflict !== conflict ||
      this.#manualHandling !== manualHandling;
    this.#contexts = contexts;
    this.#source = nextSource;
    this.#unresolved = unresolved.length > 0;
    this.#conflict = conflict;
    this.#manualHandling = manualHandling;
    if (!manualHandling) this.#selection = null;
    if (changed) ++this.#epoch;
    return changed;
  }
  /** An old terminal request stays visible while another lane's unknown command owns navigation. */
  preservesHistory(lane: ConceptRecoveryLane): boolean {
    const intent = this.#contexts[lane]?.intent;
    return Boolean(
      this.#unresolved &&
        intent &&
        (intent.phase === "accepted" || intent.phase === "refused") &&
        (this.#manualHandling ||
          this.#conflict ||
          sourceKey(intent.request.reference) !== this.#source),
    );
  }
  async restore(
    lane: ConceptRecoveryLane,
    request: Readonly<{ reference: ConceptGenerationLocator }>,
    read: () => Promise<boolean>,
  ) {
    const source = sourceKey(request.reference);
    const selected =
      this.#selection?.lane === lane &&
      this.#selection.request === requestKey(request) &&
      this.#selection.source === source;
    const permit: Permit = Object.freeze({
      source,
      epoch: this.#epoch,
      decision: this.#manualHandling
        ? selected
          ? "adopt"
          : "conflict"
        : this.#conflict
          ? "conflict"
          : this.#source !== null && source !== this.#source
            ? "history"
            : "adopt",
    });
    if (permit.decision === "conflict") return false;
    this.#permits.set(lane, permit);
    try {
      return await read();
    } finally {
      if (this.#permits.get(lane) === permit) this.#permits.delete(lane);
    }
  }
  canApply(
    lane: ConceptRecoveryLane,
    source: ConceptGenerationLocator,
  ): boolean {
    const permit = this.#permits.get(lane);
    if (!permit || permit.source !== sourceKey(source))
      throw new Error("concept_recovery_request_mismatch");
    if (permit.decision === "history") return false;
    if (permit.decision === "conflict")
      throw new Error("concept_recovery_unconfirmed_sources_conflict");
    if (
      permit.epoch !== this.#epoch ||
      (this.#manualHandling
        ? this.#selection?.lane !== lane ||
          this.#selection.source !== permit.source
        : this.#conflict) ||
      (this.#source !== null && permit.source !== this.#source)
    )
      throw new Error("concept_recovery_source_invalidated");
    return true;
  }
}
