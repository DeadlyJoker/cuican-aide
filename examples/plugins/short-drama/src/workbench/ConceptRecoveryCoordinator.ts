import type {
  ProjectGenerationHostContext,
  ProjectGenerationQueryHostContext,
  ProjectGenerationSelectionHostContext,
} from "@crewon/plugin-sdk/ui";
import type { ConceptGenerationLocator } from "@crewon/plugin-sdk/contracts";

export type ConceptRecoveryLane = "generation" | "query" | "selection";
export type ConceptRecoveryContexts = Readonly<{
  generation: ProjectGenerationHostContext | null;
  query: ProjectGenerationQueryHostContext | null;
  selection: ProjectGenerationSelectionHostContext | null;
}>;
const sourceKey = (source: ConceptGenerationLocator) =>
  JSON.stringify([source.projectId, source.assetId, source.assetRevision]);
const lanes = ["selection", "query", "generation"] as const;
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
    selection: null,
  };
  #source: string | null = null;
  #unresolved = false;
  #conflict = false;
  #epoch = 0;
  readonly #permits = new Map<ConceptRecoveryLane, Permit>();
  get contexts() {
    return this.#contexts;
  }
  get conflict() {
    return this.#conflict;
  }
  capture(input: ConceptRecoveryContexts): boolean {
    const contexts = Object.freeze({
      ...input,
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
    const first = lanes.map((lane) => contexts[lane]?.intent).find(Boolean);
    const nextSource =
      sources.size === 1
        ? [...sources][0]!
        : conflict || !first
          ? null
          : (this.#source ?? sourceKey(first.request.reference));
    const changed = this.#source !== nextSource || this.#conflict !== conflict;
    this.#contexts = contexts;
    this.#source = nextSource;
    this.#unresolved = unresolved.length > 0;
    this.#conflict = conflict;
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
        (this.#conflict ||
          sourceKey(intent.request.reference) !== this.#source),
    );
  }
  async restore(
    lane: ConceptRecoveryLane,
    request: Readonly<{ reference: ConceptGenerationLocator }>,
    read: () => Promise<boolean>,
  ) {
    const source = sourceKey(request.reference);
    const permit: Permit = Object.freeze({
      source,
      epoch: this.#epoch,
      decision: this.#conflict
        ? "conflict"
        : this.#source !== null && source !== this.#source
          ? "history"
          : "adopt",
    });
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
      this.#conflict ||
      (this.#source !== null && permit.source !== this.#source)
    )
      throw new Error("concept_recovery_source_invalidated");
    return true;
  }
}
