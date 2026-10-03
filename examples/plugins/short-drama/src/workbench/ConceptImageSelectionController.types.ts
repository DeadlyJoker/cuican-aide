import type {
  ConceptGenerationLocator,
  GetConceptSelectionResponse,
  ProjectGenerationSelectionUiInput,
  SelectConceptImageResponse,
} from "@crewon/plugin-sdk/contracts";

export type ConceptOriginalRetryPolicy = Readonly<{
  originalRetryBlocked(): boolean;
}>;

/** The visible generation, operation revision and original result index identify a choice. */
export type ConceptImageChoice = Readonly<{
  reference: ConceptGenerationLocator;
  operationId: string;
  operationRevision: number;
  resultIndex: number;
}>;
export type ConceptImageSelectionSnapshot = Readonly<{
  phase: "idle" | "loading" | "ready" | "unavailable";
  current: GetConceptSelectionResponse | null;
  intentPhase: "pending" | "uncertain" | "accepted" | "refused" | null;
  request: ProjectGenerationSelectionUiInput | null;
  /** Historical acknowledgement, never the current pointer. */
  receipt: SelectConceptImageResponse | null;
  retryable: boolean;
  recovery: "idle" | "loading" | "unavailable";
  reason: string | null;
}>;
