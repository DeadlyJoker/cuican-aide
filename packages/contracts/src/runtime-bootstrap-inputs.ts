import { ContractValidationError } from "./contract-validation-error.ts";

export const RUNTIME_BOOTSTRAP_INPUTS_SCHEMA =
  "crewon.runtime-bootstrap-inputs.v0";
export const RUNTIME_BOOTSTRAP_INPUTS_MAX_BYTES = 128 * 1024;

/** Effective, credential-free inputs supported by the current environment bootstrap. */
export type RuntimeBootstrapInputs = Readonly<{
  schemaVersion: typeof RUNTIME_BOOTSTRAP_INPUTS_SCHEMA;
  model: Readonly<{
    endpoint: string;
    modelId: string;
    credentialRequired: boolean;
    maxOutputTokens: number | null;
    storeResponses: boolean;
    requestProfile: "standard" | "responsesLite";
    idleTimeoutMs: number;
    sequencePolicy: "required" | "whenPresent";
    identityPolicy: "strict" | "terminalAuthoritative";
    outputDeltaFlushBytes: number | null;
    websocket: Readonly<{
      connectTimeoutMs: number;
      maxRetries: number;
    }> | null;
  }>;
  agent: Readonly<{
    instructions: string | null;
    contextWindowTokens: number;
    autoCompactAtTokens: number;
    streamMaxRetries: number;
    maxToolRounds: 32;
  }>;
  route: Readonly<{
    authorityId: string;
    runtimeGeneration: string;
    agentVersionId: string;
    policySnapshotId: string;
    workspaceBindingId: null;
  }>;
  /** Null preserves an undeclared catalog; a declared catalog also owns the binding manifest. */
  modelCatalog: readonly string[] | null;
  profiles: readonly Readonly<{
    agentVersionId: string;
    instructions: string;
  }>[];
  tooling: Readonly<{
    mcpStdioConfigPath: null;
    desktopWorkspaceRoot: null;
    nativeWorkspaceReadCatalog: "disabled";
  }>;
}>;

/** This is input integrity, not permission to execute a build or resolve a credential. */
export function parseRuntimeBootstrapInputs(
  input: unknown,
): RuntimeBootstrapInputs {
  const root = record(input, [
    "schemaVersion",
    "model",
    "agent",
    "route",
    "modelCatalog",
    "profiles",
    "tooling",
  ]);
  if (root.schemaVersion !== RUNTIME_BOOTSTRAP_INPUTS_SCHEMA) fail();
  const model = record(root.model, [
    "endpoint",
    "modelId",
    "credentialRequired",
    "maxOutputTokens",
    "storeResponses",
    "requestProfile",
    "idleTimeoutMs",
    "sequencePolicy",
    "identityPolicy",
    "outputDeltaFlushBytes",
    "websocket",
  ]);
  const endpoint = text(model.endpoint, 4096);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fail();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail();
  const modelId = text(model.modelId, 256);
  const maxOutputTokens =
    model.maxOutputTokens === null ? null : integer(model.maxOutputTokens, 1);
  if (
    typeof model.storeResponses !== "boolean" ||
    typeof model.credentialRequired !== "boolean"
  )
    fail();
  if (
    model.requestProfile !== "standard" &&
    model.requestProfile !== "responsesLite"
  )
    fail();
  if (
    model.sequencePolicy !== "required" &&
    model.sequencePolicy !== "whenPresent"
  )
    fail();
  if (
    model.identityPolicy !== "strict" &&
    model.identityPolicy !== "terminalAuthoritative"
  )
    fail();
  const outputDeltaFlushBytes =
    model.outputDeltaFlushBytes === null
      ? null
      : integer(model.outputDeltaFlushBytes, 1);
  let websocket: RuntimeBootstrapInputs["model"]["websocket"] = null;
  if (model.websocket !== null) {
    const ws = record(model.websocket, ["connectTimeoutMs", "maxRetries"]);
    websocket = Object.freeze({
      connectTimeoutMs: integer(ws.connectTimeoutMs, 1),
      maxRetries: integer(ws.maxRetries, 0),
    });
  }
  const portable = !(
    url.protocol === "https:" &&
    url.hostname === "api.openai.com" &&
    url.pathname.replace(/\/+$/u, "") === "/v1/responses"
  );
  if (
    portable
      ? model.storeResponses !== false ||
        model.requestProfile !== "responsesLite" ||
        model.sequencePolicy !== "whenPresent" ||
        model.identityPolicy !== "terminalAuthoritative" ||
        outputDeltaFlushBytes !== 1024 ||
        websocket !== null
      : model.identityPolicy !== "strict" || outputDeltaFlushBytes !== null
  )
    fail();
  const agent = record(root.agent, [
    "instructions",
    "contextWindowTokens",
    "autoCompactAtTokens",
    "streamMaxRetries",
    "maxToolRounds",
  ]);
  const instructions =
    agent.instructions === null
      ? null
      : text(agent.instructions, 32 * 1024, true);
  const contextWindowTokens = integer(agent.contextWindowTokens, 1);
  const autoCompactAtTokens = integer(agent.autoCompactAtTokens, 1);
  const streamMaxRetries = integer(agent.streamMaxRetries, 0);
  if (
    autoCompactAtTokens >= contextWindowTokens ||
    streamMaxRetries > 10 ||
    agent.maxToolRounds !== 32 ||
    (maxOutputTokens !== null && maxOutputTokens > contextWindowTokens)
  )
    fail();
  const route = record(root.route, [
    "authorityId",
    "runtimeGeneration",
    "agentVersionId",
    "policySnapshotId",
    "workspaceBindingId",
  ]);
  if (route.workspaceBindingId !== null) fail();
  const parsedRoute = Object.freeze({
    authorityId: text(route.authorityId, 512),
    runtimeGeneration: text(route.runtimeGeneration, 512),
    agentVersionId: text(route.agentVersionId, 512),
    policySnapshotId: text(route.policySnapshotId, 512),
    workspaceBindingId: null,
  });
  let modelCatalog: readonly string[] | null = null;
  if (root.modelCatalog !== null) {
    const values = array(root.modelCatalog, 24);
    modelCatalog = Object.freeze(
      Array.from(values, (value) => text(value, 256)),
    );
    if (
      modelCatalog.length === 0 ||
      modelCatalog[0] !== modelId ||
      new Set(modelCatalog).size !== modelCatalog.length
    )
      fail();
  }
  const profiles = Object.freeze(
    Array.from(array(root.profiles, 8), (value) => {
      const profile = record(value, ["agentVersionId", "instructions"]);
      return Object.freeze({
        agentVersionId: text(profile.agentVersionId, 512),
        instructions: text(profile.instructions, 9_999, true),
      });
    }),
  );
  if (
    new Set(profiles.map((profile) => profile.agentVersionId)).size !==
      profiles.length ||
    profiles.some(
      (profile) => profile.agentVersionId === parsedRoute.agentVersionId,
    )
  )
    fail();
  const tooling = record(root.tooling, [
    "mcpStdioConfigPath",
    "desktopWorkspaceRoot",
    "nativeWorkspaceReadCatalog",
  ]);
  if (
    tooling.mcpStdioConfigPath !== null ||
    tooling.desktopWorkspaceRoot !== null ||
    tooling.nativeWorkspaceReadCatalog !== "disabled"
  )
    fail();
  const result: RuntimeBootstrapInputs = Object.freeze({
    schemaVersion: RUNTIME_BOOTSTRAP_INPUTS_SCHEMA,
    model: Object.freeze({
      endpoint,
      modelId,
      credentialRequired: model.credentialRequired,
      maxOutputTokens,
      storeResponses: model.storeResponses,
      requestProfile: model.requestProfile,
      idleTimeoutMs: integer(model.idleTimeoutMs, 1),
      sequencePolicy: model.sequencePolicy,
      identityPolicy: model.identityPolicy,
      outputDeltaFlushBytes,
      websocket,
    }),
    agent: Object.freeze({
      instructions,
      contextWindowTokens,
      autoCompactAtTokens,
      streamMaxRetries,
      maxToolRounds: 32,
    }),
    route: parsedRoute,
    modelCatalog,
    profiles,
    tooling: Object.freeze({
      mcpStdioConfigPath: null,
      desktopWorkspaceRoot: null,
      nativeWorkspaceReadCatalog: "disabled",
    }),
  });
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    RUNTIME_BOOTSTRAP_INPUTS_MAX_BYTES
  )
    fail();
  return result;
}

function record(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !expected.includes(key) ||
        !Object.hasOwn(
          Object.getOwnPropertyDescriptor(value, key) ?? {},
          "value",
        ),
    )
  )
    fail();
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  return value;
}
function text(value: unknown, max: number, multiline = false): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > max ||
    (/[\u0000-\u001f\u007f]/u.test(value) && !multiline)
  )
    return fail();
  return value;
}
function integer(value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    return fail();
  return value;
}
function fail(): never {
  throw new ContractValidationError("runtime_bootstrap_inputs_invalid");
}
