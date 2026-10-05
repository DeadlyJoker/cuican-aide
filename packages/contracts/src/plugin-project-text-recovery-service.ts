/** Portable cold text recovery protocol. No imports, SDK changes or automatic write replay. */
export const CREWON_PROJECT_TEXT_RECOVERY_SERVICE =
  "crewon.project-text-recovery";
export const CREWON_PROJECT_TEXT_RECOVERY_API_VERSION = "1";
export const MAX_PROJECT_TEXT_RECOVERY_INPUT_BYTES = 24 * 1024;
export const MAX_PROJECT_TEXT_RECOVERY_RESPONSE_BYTES = 60 * 1024;
export const PROJECT_TEXT_RECOVERY_METHOD_ACTIONS = Object.freeze({
  getPending: "crewon.project-text-recovery.v1.getPending",
  acknowledge: "crewon.project-text-recovery.v1.acknowledge",
} as const);
export const PROJECT_TEXT_RECOVERY_ACTIONS = Object.freeze(
  Object.values(PROJECT_TEXT_RECOVERY_METHOD_ACTIONS),
);
export type ProjectTextRecoveryAction =
  (typeof PROJECT_TEXT_RECOVERY_ACTIONS)[number];
export function isProjectTextRecoveryAction(
  input: unknown,
): input is ProjectTextRecoveryAction {
  return (
    typeof input === "string" &&
    PROJECT_TEXT_RECOVERY_ACTIONS.some((action) => action === input)
  );
}
export function isProjectTextRecoveryNamespaceAction(input: unknown): boolean {
  return (
    typeof input === "string" &&
    (input === CREWON_PROJECT_TEXT_RECOVERY_SERVICE ||
      input.startsWith(`${CREWON_PROJECT_TEXT_RECOVERY_SERVICE}.`))
  );
}
type OutlineContent = Readonly<{
  title: string;
  logline: string;
  synopsis: string;
  episodes: readonly Readonly<{
    episodeId: string;
    title: string;
    summary: string;
  }>[];
}>;
type ScriptContent = Readonly<{
  title: string;
  scenes: readonly Readonly<{
    sceneId: string;
    location: string;
    timeOfDay: string;
    action: string;
    dialogue: readonly Readonly<{ speaker: string; text: string }>[];
  }>[];
}>;
export type ProjectTextRecoveryOriginalRequest =
  | Readonly<{
      action: "crewon.project-texts.v1.saveOutlineCandidate";
      input: Readonly<{
        projectId: string;
        request: Readonly<{
          expectedArtifactRevision: number;
          briefRevision: number;
          content: OutlineContent;
        }>;
        idempotencyKey: string;
      }>;
    }>
  | Readonly<{
      action: "crewon.project-texts.v1.saveScriptCandidate";
      input: Readonly<{
        projectId: string;
        episodeId: string;
        request: Readonly<{
          expectedArtifactRevision: number;
          briefRevision: number;
          outline: Readonly<{
            artifactId: string;
            contentRevision: number;
          }> | null;
          content: ScriptContent;
        }>;
        idempotencyKey: string;
      }>;
    }>
  | Readonly<{
      action: "crewon.project-texts.v1.selectRevision";
      input: Readonly<{
        projectId: string;
        artifactId: string;
        request: Readonly<{
          expectedArtifactRevision: number;
          contentRevision: number;
        }>;
        idempotencyKey: string;
      }>;
    }>
  | Readonly<{
      action: "crewon.project-texts.v1.setLocked";
      input: Readonly<{
        projectId: string;
        artifactId: string;
        request: Readonly<{
          expectedArtifactRevision: number;
          locked: boolean;
        }>;
        idempotencyKey: string;
      }>;
    }>;
export type ProjectTextRecoveryConfirmed = Readonly<{
  kind: "save-outline" | "save-script" | "select-revision" | "set-lock";
  artifactId: string;
  artifactRevision: number;
  contentRevision: number | null;
  requestDigest: string;
  resultDigest: string;
}>;
export const PROJECT_TEXT_RECOVERY_REFUSAL_CODES = Object.freeze([
  "project_text_revision_conflict",
  "project_text_locked",
  "project_text_dependencies_stale",
  "creative_project_archived",
] as const);
export type ProjectTextRecoveryRefusalCode =
  (typeof PROJECT_TEXT_RECOVERY_REFUSAL_CODES)[number];
type IntentCommon = Readonly<{
  intentId: string;
  revision: number;
  request: ProjectTextRecoveryOriginalRequest;
  requestDigest: string;
}>;
export type ProjectTextRecoveryIntent = IntentCommon &
  (
    | Readonly<{ phase: "pending"; confirmed: null; refusalCode: null }>
    | Readonly<{
        phase: "accepted";
        confirmed: ProjectTextRecoveryConfirmed;
        refusalCode: null;
      }>
    | Readonly<{
        phase: "refused";
        confirmed: null;
        refusalCode: ProjectTextRecoveryRefusalCode;
      }>
  );
export type ProjectTextRecoveryPendingResponse = Readonly<{
  intent: ProjectTextRecoveryIntent | null;
}>;
export type ProjectTextRecoveryAcknowledgementResponse = Readonly<{
  intentId: string;
  revision: number;
  disposition: "acknowledged" | "replayed";
}>;
export type ProjectTextRecoveryInputMap = Readonly<{
  "crewon.project-text-recovery.v1.getPending": Readonly<{ projectId: string }>;
  "crewon.project-text-recovery.v1.acknowledge": Readonly<{
    projectId: string;
    intentId: string;
    expectedRevision: number;
  }>;
}>;
export type ProjectTextRecoveryResponseMap = Readonly<{
  "crewon.project-text-recovery.v1.getPending": ProjectTextRecoveryPendingResponse;
  "crewon.project-text-recovery.v1.acknowledge": ProjectTextRecoveryAcknowledgementResponse;
}>;
export type ProjectTextRecoveryActionRequest = {
  [A in ProjectTextRecoveryAction]: Readonly<{
    action: A;
    input: ProjectTextRecoveryInputMap[A];
  }>;
}[ProjectTextRecoveryAction];
export type ProjectTextRecoveryJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectTextRecoveryJsonValue[]
  | Readonly<{ [key: string]: ProjectTextRecoveryJsonValue }>;
export type ProjectTextRecoveryRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;
export interface PluginProjectTextRecoveryServices {
  invoke(
    action: string,
    input: ProjectTextRecoveryJsonValue,
    options: ProjectTextRecoveryRequestOptions,
  ): Promise<ProjectTextRecoveryJsonValue>;
}
export interface ProjectTextRecoveryCodec {
  parseRequest(input: unknown): ProjectTextRecoveryActionRequest;
  parseResponse(
    request: ProjectTextRecoveryActionRequest,
    input: unknown,
  ): ProjectTextRecoveryResponseMap[ProjectTextRecoveryAction];
}
export type PluginProjectTextRecoveryClient = Readonly<{
  getPending(
    input: ProjectTextRecoveryInputMap["crewon.project-text-recovery.v1.getPending"],
    options?: ProjectTextRecoveryRequestOptions,
  ): Promise<ProjectTextRecoveryPendingResponse>;
  acknowledge(
    input: ProjectTextRecoveryInputMap["crewon.project-text-recovery.v1.acknowledge"],
    options?: ProjectTextRecoveryRequestOptions,
  ): Promise<ProjectTextRecoveryAcknowledgementResponse>;
}>;
export function createPluginProjectTextRecoveryClient(
  services: PluginProjectTextRecoveryServices,
  codec: ProjectTextRecoveryCodec,
): PluginProjectTextRecoveryClient {
  const invoke = method(services, "invoke").bind(
    services,
  ) as PluginProjectTextRecoveryServices["invoke"];
  const parseRequest = method(codec, "parseRequest").bind(
    codec,
  ) as ProjectTextRecoveryCodec["parseRequest"];
  const parseResponse = method(codec, "parseResponse").bind(
    codec,
  ) as ProjectTextRecoveryCodec["parseResponse"];
  return Object.freeze(
    Object.fromEntries(
      Object.entries(PROJECT_TEXT_RECOVERY_METHOD_ACTIONS).map(
        ([name, action]) => [
          name,
          async (
            input: unknown,
            options: ProjectTextRecoveryRequestOptions = {},
          ) => {
            if (
              options === null ||
              typeof options !== "object" ||
              ![Object.prototype, null].includes(Object.getPrototypeOf(options))
            )
              invalid();
            const fields = Object.getOwnPropertyDescriptors(options);
            if (
              Reflect.ownKeys(options).some((key) => key !== "signal") ||
              (fields.signal !== undefined &&
                (!Object.hasOwn(fields.signal, "value") ||
                  !fields.signal.enumerable))
            )
              invalid();
            const signal = fields.signal?.value as AbortSignal | undefined;
            if (signal !== undefined && !(signal instanceof AbortSignal))
              invalid();
            if (signal?.aborted)
              throw new DOMException("The operation was aborted", "AbortError");
            const request = parseRequest({ action, input });
            const response = await invoke(
              request.action,
              request.input as unknown as ProjectTextRecoveryJsonValue,
              signal === undefined ? {} : { signal },
            );
            if (signal?.aborted)
              throw new DOMException("The operation was aborted", "AbortError");
            return parseResponse(request, response);
          },
        ],
      ),
    ),
  ) as PluginProjectTextRecoveryClient;
}
function method(input: object, key: string): (...args: never[]) => unknown {
  if (input === null || typeof input !== "object") invalid();
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor === undefined) continue;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      invalid();
    return descriptor.value;
  }
  return invalid();
}
function invalid(): never {
  throw new Error("plugin_project_text_recovery_client_invalid");
}
