import type {
  ProjectAssetUiActionRequest,
  ProjectAssetUiMutationAction,
  ProjectAssetMutationKind,
} from "./project-assets-service.ts";

/** Independent, cross-project cold recovery. Metadata is never invocation authority. */
export const CREWON_PROJECT_ASSET_RECOVERY_SERVICE =
  "crewon.project-asset-recovery";
export const CREWON_PROJECT_ASSET_RECOVERY_API_VERSION = "1";
export const MAX_PROJECT_ASSET_RECOVERY_INPUT_BYTES = 1024;
export const MAX_PROJECT_ASSET_RECOVERY_RESPONSE_BYTES = 60 * 1024;
export const PROJECT_ASSET_RECOVERY_METHOD_ACTIONS = Object.freeze({
  getPending: "crewon.project-asset-recovery.v1.getPending",
  acknowledge: "crewon.project-asset-recovery.v1.acknowledge",
} as const);
export const PROJECT_ASSET_RECOVERY_ACTIONS = Object.freeze(
  Object.values(PROJECT_ASSET_RECOVERY_METHOD_ACTIONS),
);
export type ProjectAssetRecoveryAction =
  (typeof PROJECT_ASSET_RECOVERY_ACTIONS)[number];
export function isProjectAssetRecoveryAction(
  input: unknown,
): input is ProjectAssetRecoveryAction {
  return (
    typeof input === "string" &&
    PROJECT_ASSET_RECOVERY_ACTIONS.some((action) => action === input)
  );
}
export function isProjectAssetRecoveryNamespaceAction(input: unknown): boolean {
  return (
    typeof input === "string" &&
    (input === CREWON_PROJECT_ASSET_RECOVERY_SERVICE ||
      input.startsWith(`${CREWON_PROJECT_ASSET_RECOVERY_SERVICE}.`))
  );
}
export type ProjectAssetRecoveryOriginalRequest = Extract<
  ProjectAssetUiActionRequest,
  { action: ProjectAssetUiMutationAction }
>;
export type ProjectAssetRecoveryConfirmed = Readonly<{
  kind: ProjectAssetMutationKind;
  assetId: string;
  assetRevision: number;
  contentRevision: number | null;
  referenceRevision: number | null;
  requestDigest: string;
  resultDigest: string;
}>;
export const PROJECT_ASSET_RECOVERY_REFUSAL_CODES = Object.freeze([
  "project_asset_revision_conflict",
  "project_asset_locked",
  "project_asset_source_stale",
  "project_asset_concept_selection_changed",
  "project_asset_reference_stale",
  "creative_project_archived",
] as const);
export type ProjectAssetRecoveryRefusalCode =
  (typeof PROJECT_ASSET_RECOVERY_REFUSAL_CODES)[number];
type IntentCommon = Readonly<{
  intentId: string;
  revision: number;
  request: ProjectAssetRecoveryOriginalRequest;
  requestDigest: string;
}>;
export type ProjectAssetRecoveryIntent = IntentCommon &
  (
    | Readonly<{ phase: "pending"; confirmed: null; refusalCode: null }>
    | Readonly<{
        phase: "accepted";
        confirmed: ProjectAssetRecoveryConfirmed;
        refusalCode: null;
      }>
    | Readonly<{
        phase: "refused";
        confirmed: null;
        refusalCode: ProjectAssetRecoveryRefusalCode;
      }>
  );
export type ProjectAssetRecoveryPendingResponse = Readonly<{
  intent: ProjectAssetRecoveryIntent | null;
}>;
export type ProjectAssetRecoveryAcknowledgementResponse = Readonly<{
  intentId: string;
  revision: number;
  disposition: "acknowledged" | "replayed";
}>;
export type ProjectAssetRecoveryInputMap = Readonly<{
  "crewon.project-asset-recovery.v1.getPending": Readonly<
    Record<string, never>
  >;
  "crewon.project-asset-recovery.v1.acknowledge": Readonly<{
    intentId: string;
    expectedRevision: number;
  }>;
}>;
export type ProjectAssetRecoveryResponseMap = Readonly<{
  "crewon.project-asset-recovery.v1.getPending": ProjectAssetRecoveryPendingResponse;
  "crewon.project-asset-recovery.v1.acknowledge": ProjectAssetRecoveryAcknowledgementResponse;
}>;
export type ProjectAssetRecoveryActionRequest = {
  [A in ProjectAssetRecoveryAction]: Readonly<{
    action: A;
    input: ProjectAssetRecoveryInputMap[A];
  }>;
}[ProjectAssetRecoveryAction];
export type ProjectAssetRecoveryJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectAssetRecoveryJsonValue[]
  | Readonly<{ [key: string]: ProjectAssetRecoveryJsonValue }>;
export type ProjectAssetRecoveryRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;
export interface PluginProjectAssetRecoveryServices {
  invoke(
    action: string,
    input: ProjectAssetRecoveryJsonValue,
    options: ProjectAssetRecoveryRequestOptions,
  ): Promise<ProjectAssetRecoveryJsonValue>;
}
export interface ProjectAssetRecoveryCodec {
  parseRequest(input: unknown): ProjectAssetRecoveryActionRequest;
  parseResponse(
    request: ProjectAssetRecoveryActionRequest,
    input: unknown,
  ): ProjectAssetRecoveryResponseMap[ProjectAssetRecoveryAction];
}
export type PluginProjectAssetRecoveryClient = Readonly<{
  getPending(
    input: ProjectAssetRecoveryInputMap["crewon.project-asset-recovery.v1.getPending"],
    options?: ProjectAssetRecoveryRequestOptions,
  ): Promise<ProjectAssetRecoveryPendingResponse>;
  acknowledge(
    input: ProjectAssetRecoveryInputMap["crewon.project-asset-recovery.v1.acknowledge"],
    options?: ProjectAssetRecoveryRequestOptions,
  ): Promise<ProjectAssetRecoveryAcknowledgementResponse>;
}>;
export function createPluginProjectAssetRecoveryClient(
  services: PluginProjectAssetRecoveryServices,
  codec: ProjectAssetRecoveryCodec,
): PluginProjectAssetRecoveryClient {
  const invoke = method(services, "invoke").bind(
      services,
    ) as PluginProjectAssetRecoveryServices["invoke"],
    parseRequest = method(codec, "parseRequest").bind(
      codec,
    ) as ProjectAssetRecoveryCodec["parseRequest"],
    parseResponse = method(codec, "parseResponse").bind(
      codec,
    ) as ProjectAssetRecoveryCodec["parseResponse"];
  return Object.freeze(
    Object.fromEntries(
      Object.entries(PROJECT_ASSET_RECOVERY_METHOD_ACTIONS).map(
        ([name, action]) => [
          name,
          async (
            input: unknown,
            options: ProjectAssetRecoveryRequestOptions = {},
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
            signal?.throwIfAborted();
            const request = parseRequest({ action, input });
            const result = await invoke(
              request.action,
              request.input as ProjectAssetRecoveryJsonValue,
              signal === undefined ? {} : { signal },
            );
            signal?.throwIfAborted();
            return parseResponse(request, result);
          },
        ],
      ),
    ),
  ) as PluginProjectAssetRecoveryClient;
}
function method(input: object, key: string): (...args: never[]) => unknown {
  if (input === null || typeof input !== "object") invalid();
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    depth++, owner = Object.getPrototypeOf(owner)
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
  throw new Error("plugin_project_asset_recovery_client_invalid");
}
