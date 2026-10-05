/** Independent public protocol. Portable: no runtime or type imports. */
export const CREWON_PROJECT_TEXT_PLANS_SERVICE = "crewon.project-text-plans";
export const CREWON_PROJECT_TEXT_PLANS_API_VERSION = "1";
export const MAX_PROJECT_TEXT_PLANS_INPUT_BYTES = 24 * 1024;
export const MAX_PROJECT_TEXT_PLANS_VIEW_BYTES = 60 * 1024;
export const MAX_PROJECT_TEXT_PLAN_INSTRUCTION_BYTES = 4096;
export const PROJECT_TEXT_PLANS_METHOD_ACTIONS = Object.freeze({
  start: "crewon.project-text-plans.v1.start",
  get: "crewon.project-text-plans.v1.get",
  list: "crewon.project-text-plans.v1.list",
  pause: "crewon.project-text-plans.v1.pause",
  resume: "crewon.project-text-plans.v1.resume",
  revoke: "crewon.project-text-plans.v1.revoke",
  reviseRemaining: "crewon.project-text-plans.v1.reviseRemaining",
  continue: "crewon.project-text-plans.v1.continue",
} as const);
export type PublicProjectTextPlanStage = "brief" | "outline" | "script";
export type PublicProjectTextPlanAdoption = "manual" | "whenUnchanged";
export type PublicProjectTextPlanEpisodeSelection =
  | Readonly<{ kind: "newOutline"; episodeCount: number }>
  | Readonly<{ kind: "selectedOutline"; episodeIds: readonly string[] }>
  | Readonly<{ kind: "independentScripts"; episodeIds: readonly string[] }>;
export type PublicProjectTextPlanState =
  | "ready"
  | "running"
  | "waitingSelection"
  | "paused"
  | "completed"
  | "revoked";
export type PublicProjectTextPlanPauseReason =
  | "source_changed"
  | "selection_changed"
  | "locked"
  | "binding_changed"
  | "installation_changed"
  | "authorization_unavailable"
  | "run_failed"
  | "run_canceled"
  | "result_missing"
  | "result_invalid"
  | "user_paused";
export type PublicProjectTextPlanSources = Readonly<{
  brief: Readonly<{ briefRevision: number; contentDigest: string }>;
  outline: Readonly<{
    artifactId: string;
    contentRevision: number;
    contentDigest: string;
  }> | null;
}>;
export type PublicProjectTextPlanSummary = Readonly<{
  planId: string;
  projectId: string;
  threadId: string;
  revision: number;
  currentPlanRevision: number;
  state: PublicProjectTextPlanState;
  activeStepId: string | null;
  pauseReason: PublicProjectTextPlanPauseReason | null;
  createdAt: string;
  updatedAt: string;
}>;
export type PublicProjectTextPlanDefinition = Readonly<{
  planId: string;
  planRevision: number;
  start: PublicProjectTextPlanStage;
  target: PublicProjectTextPlanStage;
  episodeMode: "none" | PublicProjectTextPlanEpisodeSelection["kind"];
  episodeIds: readonly string[];
  adoption: PublicProjectTextPlanAdoption;
  instruction: string;
  sources: PublicProjectTextPlanSources;
}>;
export type PublicProjectTextPlanResult = Readonly<{
  kind: PublicProjectTextPlanStage;
  briefRevision: number | null;
  artifactId: string | null;
  artifactRevision: number | null;
  contentRevision: number | null;
  contentDigest: string;
}>;
export type PublicProjectTextPlanSelection = Readonly<{
  mode: PublicProjectTextPlanAdoption;
  artifactId: string;
  artifactRevision: number;
  contentRevision: number;
  contentDigest: string;
}>;
export type PublicProjectTextPlanStep = Readonly<{
  stepId: string;
  ordinal: number;
  kind: PublicProjectTextPlanStage;
  episodeId: string | null;
  attempt: number;
  revision: number;
  state:
    | "ready"
    | "admitted"
    | "waitingSelection"
    | "succeeded"
    | "paused"
    | "failed"
    | "revoked";
  sources: PublicProjectTextPlanSources | null;
  run: Readonly<{ runId: string; stageAdmissionDigest: string }> | null;
  result: PublicProjectTextPlanResult | null;
  selection: PublicProjectTextPlanSelection | null;
  terminal: Readonly<{
    status: "completed" | "failed" | "canceled";
    runRevision: number;
    throughSequence: number;
  }> | null;
}>;
export type PublicProjectTextPlanView = Readonly<{
  plan: PublicProjectTextPlanSummary;
  definition: PublicProjectTextPlanDefinition;
  steps: readonly PublicProjectTextPlanStep[];
}>;
export type ProjectTextPlanDefinitionInput = Readonly<{
  expectedBriefRevision: number;
  instruction: string;
  start: PublicProjectTextPlanStage;
  target: PublicProjectTextPlanStage;
  episodes: PublicProjectTextPlanEpisodeSelection | null;
  adoption: PublicProjectTextPlanAdoption;
}>;
export type ProjectTextPlanControlInput = Readonly<{
  projectId: string;
  planId: string;
  expectedRevision: number;
  idempotencyKey: string;
}>;
export type ProjectTextPlansRequests = {
  start: ProjectTextPlanDefinitionInput &
    Readonly<{
      projectId: string;
      threadId: string;
      expectedBindingRevision: number;
      idempotencyKey: string;
    }>;
  get: Readonly<{ projectId: string; planId: string }>;
  list: Readonly<{
    projectId: string;
    afterPlanId: string | null;
    limit: number;
  }>;
  pause: ProjectTextPlanControlInput;
  resume: ProjectTextPlanControlInput;
  revoke: ProjectTextPlanControlInput;
  reviseRemaining: ProjectTextPlanControlInput & ProjectTextPlanDefinitionInput;
  continue: ProjectTextPlanControlInput;
};
export type ProjectTextPlanMutationResponse = Readonly<{
  disposition: "committed" | "replayed";
  view: PublicProjectTextPlanView;
}>;
export type ProjectTextPlansResponses = {
  start: ProjectTextPlanMutationResponse;
  get: Readonly<{ view: PublicProjectTextPlanView | null }>;
  list: Readonly<{
    plans: readonly PublicProjectTextPlanSummary[];
    nextPlanId: string | null;
  }>;
  pause: ProjectTextPlanMutationResponse;
  resume: ProjectTextPlanMutationResponse;
  revoke: ProjectTextPlanMutationResponse;
  reviseRemaining: ProjectTextPlanMutationResponse;
  continue: ProjectTextPlanMutationResponse;
};
export type ProjectTextPlansMethod =
  keyof typeof PROJECT_TEXT_PLANS_METHOD_ACTIONS;
export type ProjectTextPlansAction =
  (typeof PROJECT_TEXT_PLANS_METHOD_ACTIONS)[ProjectTextPlansMethod];
export type ProjectTextPlansInputMap = {
  [M in ProjectTextPlansMethod as (typeof PROJECT_TEXT_PLANS_METHOD_ACTIONS)[M]]: ProjectTextPlansRequests[M];
};
export type ProjectTextPlansResponseMap = {
  [M in ProjectTextPlansMethod as (typeof PROJECT_TEXT_PLANS_METHOD_ACTIONS)[M]]: ProjectTextPlansResponses[M];
};
export type ProjectTextPlansActionRequest = {
  [A in ProjectTextPlansAction]: Readonly<{
    action: A;
    input: ProjectTextPlansInputMap[A];
  }>;
}[ProjectTextPlansAction];
export type ProjectTextPlansJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectTextPlansJsonValue[]
  | { readonly [key: string]: ProjectTextPlansJsonValue };
export interface PluginProjectTextPlansServices {
  invoke(
    action: string,
    input: ProjectTextPlansJsonValue,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}
export type ProjectTextPlansRequestOptions = Readonly<{ signal?: AbortSignal }>;
export interface ProjectTextPlansCodec {
  parseRequest(input: unknown): ProjectTextPlansActionRequest;
  parseResponse(
    request: ProjectTextPlansActionRequest,
    input: unknown,
  ): ProjectTextPlansResponseMap[ProjectTextPlansAction];
}
export type PluginProjectTextPlansClient = Readonly<{
  [M in ProjectTextPlansMethod]: (
    input: ProjectTextPlansRequests[M],
    options?: ProjectTextPlansRequestOptions,
  ) => Promise<ProjectTextPlansResponses[M]>;
}>;

/** Capture the dispatcher and strict codec once; writes are never retried automatically. */
export function createPluginProjectTextPlansClient(
  services: PluginProjectTextPlansServices,
  codec: ProjectTextPlansCodec,
): PluginProjectTextPlansClient {
  const invoke = method(services, "invoke").bind(services);
  const parseRequest = method(codec, "parseRequest").bind(codec);
  const parseResponse = method(codec, "parseResponse").bind(codec);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(PROJECT_TEXT_PLANS_METHOD_ACTIONS).map(
        ([name, action]) => [
          name,
          async (
            input: unknown,
            options: ProjectTextPlansRequestOptions = {},
          ) => {
            if (options === null || typeof options !== "object")
              invalidClient();
            const descriptors = Object.getOwnPropertyDescriptors(options);
            if (
              Reflect.ownKeys(options).some((key) => key !== "signal") ||
              (descriptors.signal !== undefined &&
                (!Object.hasOwn(descriptors.signal, "value") ||
                  !descriptors.signal.enumerable))
            )
              invalidClient();
            const signal = descriptors.signal?.value as AbortSignal | undefined;
            if (signal !== undefined && !(signal instanceof AbortSignal))
              invalidClient();
            signal?.throwIfAborted();
            const request = parseRequest({
              action,
              input,
            }) as ProjectTextPlansActionRequest;
            const output = await invoke(
              request.action,
              request.input,
              signal === undefined ? {} : { signal },
            );
            signal?.throwIfAborted();
            return parseResponse(request, output);
          },
        ],
      ),
    ),
  ) as PluginProjectTextPlansClient;
}
function method(input: object, key: string): (...args: unknown[]) => unknown {
  if (input === null || typeof input !== "object") invalidClient();
  let owner: object | null = input;
  for (
    let depth = 0;
    owner !== null && depth < 16;
    depth++, owner = Object.getPrototypeOf(owner)
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (d === undefined) continue;
    if (!Object.hasOwn(d, "value") || typeof d.value !== "function")
      invalidClient();
    return d.value;
  }
  return invalidClient();
}
function invalidClient(): never {
  throw new Error("plugin_project_text_plans_client_invalid");
}
