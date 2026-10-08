/** Independent portable query-only protocol; no caller-selectable execution target. */
export const CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE =
  "crewon.project-historical-queries";
export const CREWON_PROJECT_HISTORICAL_QUERIES_API_VERSION = "1";
export const PROJECT_HISTORICAL_QUERY_UI_ACTIONS = Object.freeze([
  "crewon.project-historical-queries.v1.queryConceptGeneration",
] as const);
export type ProjectHistoricalQueryUiAction =
  (typeof PROJECT_HISTORICAL_QUERY_UI_ACTIONS)[number];
export type ProjectHistoricalQueryUiInput = Readonly<{
  reference: Readonly<{
    projectId: string;
    assetId: string;
    assetRevision: number;
  }>;
  operationId: string;
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
}>;
export type ProjectHistoricalQueryUiActionRequest = Readonly<{
  action: ProjectHistoricalQueryUiAction;
  input: ProjectHistoricalQueryUiInput;
}>;
export type ProjectHistoricalQueryUiReceipt = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  messageId: string;
  configurationRevision: number;
}>;
/** Portable declaration shape; the mounted UI client still requires a native AbortSignal. */
export type ProjectHistoricalQueryAbortSignal = Readonly<{
  aborted: boolean;
  reason: unknown;
  throwIfAborted(): void;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: Readonly<{ once?: boolean }>,
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}>;
export type PluginProjectHistoricalQueryClient = Readonly<{
  queryConceptGeneration(
    input: ProjectHistoricalQueryUiInput,
    options?: Readonly<{ signal?: ProjectHistoricalQueryAbortSignal }>,
  ): Promise<ProjectHistoricalQueryUiReceipt>;
}>;

export const PROJECT_HISTORICAL_QUERY_HOST_CONTEXT_VERSION =
  "crewon.project-historical-query-host-context.v1";
export type ProjectHistoricalQueryHostIntent = Readonly<{
  request: ProjectHistoricalQueryUiInput;
  phase: "pending" | "uncertain" | "accepted" | "refused";
  retryable: boolean;
  receipt: ProjectHistoricalQueryUiReceipt | null;
}>;
/** Bounded display/recovery data. It never supplies the current session or query authority. */
export type ProjectHistoricalQueryHostContext = Readonly<{
  version: typeof PROJECT_HISTORICAL_QUERY_HOST_CONTEXT_VERSION;
  recovery: "session-only";
  phase: "idle" | "loading" | "ready" | "uncertain" | "error";
  thread: Readonly<{
    threadId: string;
    revision: number;
    provisional: boolean;
  }> | null;
  threadReady: boolean;
  intent: ProjectHistoricalQueryHostIntent | null;
}>;
