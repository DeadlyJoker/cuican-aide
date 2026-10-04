import type { PluginProjectGenerationReadClient } from "@crewon/plugin-sdk/ui";
import type {
  ConceptGenerationLocator,
  PublicConceptGeneration,
  ProjectGenerationUiReceipt,
} from "@crewon/plugin-sdk/contracts";
import {
  GENERATION_OBSERVATION_LIMITS,
  generationNeedsObservation,
} from "./ConceptGenerationObservation";

export type ConceptGenerationSnapshot = Readonly<{
  phase: "idle" | "loading" | "ready" | "unavailable";
  source: ConceptGenerationLocator | null;
  generation: PublicConceptGeneration | null;
  reading: boolean;
  observation: "idle" | "watching" | "paused" | "exhausted";
}>;
const initial = (): ConceptGenerationSnapshot => ({
  phase: "idle",
  source: null,
  generation: null,
  reading: false,
  observation: "idle",
});

const sourceKey = (source: ConceptGenerationLocator) =>
  JSON.stringify([source.projectId, source.assetId, source.assetRevision]);
type ObservationWindow = {
  expiresAt: number;
  reads: number;
  queryAccepted: boolean;
};

/** Observes one immutable saved input. Refresh never generates, polls a supplier or selects a result. */
export class ConceptGenerationController {
  readonly #read: PluginProjectGenerationReadClient["getConceptGeneration"];
  readonly #listeners = new Set<() => void>();
  #snapshot = initial();
  #key: string | null = null;
  #disposed = false;
  #pending: AbortController | null = null;
  #pendingMode: "foreground" | "background" | null = null;
  #visible = false;
  #window: ObservationWindow | null = null;
  #nextRead: ReturnType<typeof setTimeout> | null = null;
  #deadline: ReturnType<typeof setTimeout> | null = null;
  #expected: { key: string; receipt: ProjectGenerationUiReceipt } | null = null;
  #observedQuery: { key: string; runId: string; started: boolean } | null =
    null;
  constructor(client: PluginProjectGenerationReadClient) {
    this.#read = client.getConceptGeneration.bind(client);
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #update(change: Partial<ConceptGenerationSnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
  bind(source: ConceptGenerationLocator | null, ready: boolean) {
    if (this.#disposed) return;
    const next = ready && source ? Object.freeze({ ...source }) : null;
    const key = next === null ? null : sourceKey(next);
    if (key === this.#key) return;
    this.#pending?.abort();
    this.#pending = null;
    this.#pendingMode = null;
    this.#stopObservation("idle");
    this.#key = key;
    this.#update({ ...initial(), source: next });
    if (next !== null) {
      if (this.#observedQuery?.key === key && !this.#observedQuery.started) {
        this.#observedQuery.started = true;
        this.#startObservation(true);
        void this.#readRecord("foreground");
      } else void this.refresh();
    }
  }
  async refresh() {
    const source = this.#snapshot.source;
    if (this.#disposed || source === null || this.#pending !== null) return;
    this.#startObservation(this.#window?.queryAccepted ?? false);
    await this.#readRecord("foreground");
  }
  async #readRecord(mode: "foreground" | "background") {
    const source = this.#snapshot.source;
    if (this.#disposed || source === null || this.#pending !== null) return;
    const controller = new AbortController();
    this.#pending = controller;
    this.#pendingMode = mode;
    const key = this.#key;
    const current = () =>
      !this.#disposed &&
      !controller.signal.aborted &&
      this.#pending === controller &&
      this.#key === key;
    // Keep the last confirmed record during background reads to avoid flashing images.
    this.#update(
      mode === "foreground"
        ? { phase: "loading", generation: null, reading: true }
        : { reading: true },
    );
    const timeout = setTimeout(() => {
      if (!current()) return;
      controller.abort();
      this.#stopObservation("idle");
      this.#update({
        phase: "unavailable",
        generation: null,
        reading: false,
      });
    }, GENERATION_OBSERVATION_LIMITS.readTimeoutMs);
    try {
      if (!current()) return;
      const response = await this.#read(source, { signal: controller.signal });
      if (
        current() &&
        this.#expected?.key === key &&
        (response.generation?.task.runId !== this.#expected.receipt.runId ||
          response.generation?.task.threadId !==
            this.#expected.receipt.threadId ||
          response.generation?.task.configurationRevision !==
            this.#expected.receipt.configurationRevision)
      )
        throw new Error("generation_receipt_record_mismatch");
      if (current()) {
        this.#update({ phase: "ready", generation: response.generation });
        if (
          !this.#window?.queryAccepted &&
          (response.generation === null ||
            !generationNeedsObservation(response.generation))
        )
          this.#stopObservation("idle");
      }
    } catch {
      if (current()) {
        this.#stopObservation("idle");
        this.#update({ phase: "unavailable", generation: null });
      }
    } finally {
      clearTimeout(timeout);
      if (this.#pending === controller) {
        this.#pending = null;
        this.#pendingMode = null;
        this.#update({ reading: false });
        this.#scheduleObservation();
      }
    }
  }

  setVisible(visible: boolean) {
    if (this.#disposed || visible === this.#visible) return;
    this.#visible = visible;
    if (!visible) {
      this.#clearNextRead();
      this.#pending?.abort();
      this.#update({
        reading: false,
        observation: this.#window ? "paused" : this.#snapshot.observation,
      });
    } else this.#scheduleObservation();
  }
  #clearNextRead() {
    if (this.#nextRead !== null) clearTimeout(this.#nextRead);
    this.#nextRead = null;
  }
  #stopObservation(observation: ConceptGenerationSnapshot["observation"]) {
    this.#clearNextRead();
    if (this.#deadline !== null) clearTimeout(this.#deadline);
    this.#deadline = null;
    this.#window = null;
    this.#update({ observation });
  }
  #startObservation(queryAccepted: boolean) {
    this.#stopObservation("idle");
    const window: ObservationWindow = {
      expiresAt: Date.now() + GENERATION_OBSERVATION_LIMITS.windowMs,
      reads: 0,
      queryAccepted,
    };
    this.#window = window;
    this.#deadline = setTimeout(() => {
      if (this.#window !== window) return;
      if (this.#pendingMode === "background") {
        this.#pending?.abort();
        this.#update({ reading: false });
      }
      this.#stopObservation("exhausted");
    }, GENERATION_OBSERVATION_LIMITS.windowMs);
    this.#update({ observation: this.#visible ? "watching" : "paused" });
  }
  #scheduleObservation() {
    const window = this.#window;
    if (
      !window ||
      !this.#visible ||
      this.#disposed ||
      this.#snapshot.source === null ||
      this.#pending !== null
    )
      return;
    if (
      window.reads >= GENERATION_OBSERVATION_LIMITS.maximumReads ||
      Date.now() >= window.expiresAt
    ) {
      this.#stopObservation("exhausted");
      return;
    }
    this.#clearNextRead();
    this.#update({ observation: "watching" });
    this.#nextRead = setTimeout(() => {
      this.#nextRead = null;
      if (this.#window !== window || !this.#visible || this.#disposed) return;
      if (Date.now() >= window.expiresAt) {
        this.#stopObservation("exhausted");
        return;
      }
      ++window.reads;
      void this.#readRecord("background");
    }, GENERATION_OBSERVATION_LIMITS.intervalMs);
  }
  expectReceipt(
    source: ConceptGenerationLocator,
    receipt: ProjectGenerationUiReceipt,
  ) {
    const key = sourceKey(source);
    if (
      this.#expected?.key === key &&
      this.#expected.receipt.runId === receipt.runId
    )
      return;
    this.#expected = { key, receipt };
    if (this.#disposed || this.#key !== key) return;
    this.#startObservation(false);
    if (this.#pending !== null) {
      // A read started before acceptance may contain the previous record.
      this.#pending.abort();
      this.#update({ phase: "loading", generation: null, reading: false });
    } else void this.#readRecord("foreground");
  }
  /** A query receipt identifies another Run, absent from the original-generation projection. */
  expectQueryReceipt(
    source: ConceptGenerationLocator,
    receipt: ProjectGenerationUiReceipt,
  ) {
    if (this.#disposed) return;
    const key = sourceKey(source);
    if (
      this.#observedQuery?.key === key &&
      this.#observedQuery.runId === receipt.runId
    )
      return;
    this.#observedQuery = { key, runId: receipt.runId, started: false };
    if (this.#key !== key) return;
    this.#observedQuery.started = true;
    this.#startObservation(true);
    if (this.#pending === null) void this.#readRecord("foreground");
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopObservation("idle");
    this.#pending?.abort();
    this.#pending = null;
    this.#key = null;
    this.#listeners.clear();
  }
}
