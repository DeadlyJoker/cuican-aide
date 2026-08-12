import { createPrivateKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  DeviceToolRuntime,
  Ed25519DeviceCommandSigner,
  HttpsDeviceDispatchClient,
} from "@crewon/device-dispatch";
import type {
  ToolDefinition,
  ToolExecutionPolicy,
  ToolRuntimePort,
} from "@crewon/tool-broker";
import { InMemoryToolBroker } from "@crewon/tool-broker";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TOOLS = 128;
const MAX_BINDINGS = 10_000;
const RAW_READ_CAPABILITY = "workspace.read_file.raw_tool.v0";

type DeviceToolRuntimeConfig = Readonly<{
  schemaVersion: "crewon.device-tool-runtime.v0";
  gateway: Readonly<{
    endpoint: string;
    tlsKeyPath: string;
    tlsCertPath: string;
    tlsCaPath: string;
    servername: string | null;
    requestTimeoutMs: number;
  }>;
  signing: Readonly<{
    keyId: string;
    privateKeyPath: string;
    authorizationTtlMs: number;
  }>;
  bindings: readonly Readonly<{ bindingId: string; deviceId: string }>[];
  tools: readonly Readonly<{
    definition: ToolDefinition;
    policy: ToolExecutionPolicy;
  }>[];
}>;

/** Loads one explicit Device deployment without ambient credentials or routes. */
export function loadDeviceToolRuntime(
  path: string,
  agentTools?: readonly ToolDefinition[],
): ToolRuntimePort {
  const config = parseDeviceToolRuntimeConfig(
    readBoundedJson(
      path,
      MAX_CONFIG_BYTES,
      "CREWON_DEVICE_TOOL_CONFIG_PATH_invalid",
    ),
  );
  const bindings = new Map(
    config.bindings.map((binding) => [binding.bindingId, binding.deviceId]),
  );
  const policies = new Map(
    config.tools.map(({ definition, policy }) => [toolKey(definition), policy]),
  );
  const privateKey = createPrivateKey(
    readBoundedFile(
      config.signing.privateKeyPath,
      64 * 1024,
      "device_signing_private_key_invalid",
    ),
  );
  if (agentTools !== undefined) {
    for (const { definition } of config.tools) {
      const released = agentTools.find(
        (candidate) => toolKey(candidate) === toolKey(definition),
      );
      if (
        released === undefined ||
        stableJson(released) !== stableJson(definition)
      ) {
        throw new Error("device_tool_agent_version_mismatch");
      }
    }
  }
  return new DeviceToolRuntime({
    definitions: config.tools.map(({ definition }) => definition),
    policies,
    bindings: {
      async resolve(bindingId) {
        const deviceId = bindings.get(bindingId);
        return deviceId === undefined ? null : { deviceId };
      },
    },
    signer: new Ed25519DeviceCommandSigner({
      keyId: config.signing.keyId,
      privateKey,
      authorizationTtlMs: config.signing.authorizationTtlMs,
    }),
    dispatch: new HttpsDeviceDispatchClient({
      endpoint: config.gateway.endpoint,
      tls: {
        key: readBoundedFile(
          config.gateway.tlsKeyPath,
          1024 * 1024,
          "device_gateway_tls_key_invalid",
        ),
        cert: readBoundedFile(
          config.gateway.tlsCertPath,
          4 * 1024 * 1024,
          "device_gateway_tls_cert_invalid",
        ),
        ca: readBoundedFile(
          config.gateway.tlsCaPath,
          4 * 1024 * 1024,
          "device_gateway_tls_ca_invalid",
        ),
        ...(config.gateway.servername === null
          ? {}
          : { servername: config.gateway.servername }),
      },
      requestTimeoutMs: config.gateway.requestTimeoutMs,
    }),
  });
}

export function parseDeviceToolRuntimeConfig(
  input: unknown,
): DeviceToolRuntimeConfig {
  if (
    !hasExactKeys(input, [
      "bindings",
      "gateway",
      "schemaVersion",
      "signing",
      "tools",
    ]) ||
    input.schemaVersion !== "crewon.device-tool-runtime.v0" ||
    !Array.isArray(input.bindings) ||
    input.bindings.length < 1 ||
    input.bindings.length > MAX_BINDINGS ||
    !Array.isArray(input.tools) ||
    input.tools.length < 1 ||
    input.tools.length > MAX_TOOLS
  ) {
    throw new Error("device_tool_runtime_config_invalid");
  }
  const gateway = parseGateway(input.gateway);
  const signing = parseSigning(input.signing);
  const bindingIds = new Set<string>();
  const bindings = input.bindings.map((value) => {
    if (!hasExactKeys(value, ["bindingId", "deviceId"])) {
      throw new Error("device_tool_binding_invalid");
    }
    const bindingId = opaqueId(value.bindingId, "device_tool_binding_invalid");
    const deviceId = opaqueId(value.deviceId, "device_tool_binding_invalid");
    if (bindingIds.has(bindingId)) {
      throw new Error("device_tool_binding_duplicate");
    }
    bindingIds.add(bindingId);
    return { bindingId, deviceId };
  });
  const toolKeys = new Set<string>();
  const tools = input.tools.map((value) => {
    if (!hasExactKeys(value, ["definition", "policy"])) {
      throw new Error("device_tool_config_invalid");
    }
    const definition = parseDefinition(value.definition);
    const policy = parsePolicy(value.policy);
    const key = toolKey(definition);
    if (
      toolKeys.has(key) ||
      policy.executionTarget.kind !== "device" ||
      !bindingIds.has(policy.executionTarget.bindingId) ||
      policy.effect !== "readOnly" ||
      policy.recovery !== "replaySafe" ||
      policy.capability !== RAW_READ_CAPABILITY ||
      policy.approvalRequirement !== "none" ||
      policy.resourceBindingId !== null ||
      policy.credentialBindingId !== null
    ) {
      throw new Error("device_tool_policy_invalid");
    }
    if (!isNativeRawReadDefinition(definition)) {
      throw new Error("device_tool_native_allowlist_invalid");
    }
    toolKeys.add(key);
    return { definition, policy };
  });
  new InMemoryToolBroker(
    tools.map(({ definition }) => definition),
    new Map(),
    new Map(
      tools.map(({ definition, policy }) => [toolKey(definition), policy]),
    ),
  );
  return {
    schemaVersion: "crewon.device-tool-runtime.v0",
    gateway,
    signing,
    bindings,
    tools,
  };
}

function parseGateway(value: unknown): DeviceToolRuntimeConfig["gateway"] {
  if (
    !hasExactKeys(value, [
      "endpoint",
      "requestTimeoutMs",
      "servername",
      "tlsCaPath",
      "tlsCertPath",
      "tlsKeyPath",
    ])
  ) {
    throw new Error("device_gateway_config_invalid");
  }
  const servername =
    value.servername === null
      ? null
      : boundedString(value.servername, 253, "device_gateway_config_invalid");
  if (
    !Number.isSafeInteger(value.requestTimeoutMs) ||
    Number(value.requestTimeoutMs) < 1_000 ||
    Number(value.requestTimeoutMs) > 24 * 60 * 60 * 1_000
  ) {
    throw new Error("device_gateway_config_invalid");
  }
  return {
    endpoint: httpsEndpoint(value.endpoint),
    tlsKeyPath: boundedPath(value.tlsKeyPath),
    tlsCertPath: boundedPath(value.tlsCertPath),
    tlsCaPath: boundedPath(value.tlsCaPath),
    servername,
    requestTimeoutMs: Number(value.requestTimeoutMs),
  };
}

function parseSigning(value: unknown): DeviceToolRuntimeConfig["signing"] {
  if (
    !hasExactKeys(value, ["authorizationTtlMs", "keyId", "privateKeyPath"]) ||
    !Number.isSafeInteger(value.authorizationTtlMs) ||
    Number(value.authorizationTtlMs) < 1_000 ||
    Number(value.authorizationTtlMs) > 5 * 60 * 1_000
  ) {
    throw new Error("device_signing_config_invalid");
  }
  return {
    keyId: opaqueId(value.keyId, "device_signing_config_invalid"),
    privateKeyPath: boundedPath(value.privateKeyPath),
    authorizationTtlMs: Number(value.authorizationTtlMs),
  };
}

function parseDefinition(value: unknown): ToolDefinition {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== "crewon.tool-definition.v0" ||
    (value.kind !== "function" && value.kind !== "custom")
  ) {
    throw new Error("device_tool_definition_invalid");
  }
  const expected =
    value.kind === "function"
      ? [
          "description",
          "execution",
          "inputSchema",
          "kind",
          "name",
          "schemaVersion",
        ]
      : [
          "description",
          "execution",
          "inputFormat",
          "kind",
          "name",
          "schemaVersion",
        ];
  if (!hasExactKeys(value, expected)) {
    throw new Error("device_tool_definition_invalid");
  }
  return structuredClone(value) as ToolDefinition;
}

function parsePolicy(value: unknown): ToolExecutionPolicy {
  if (
    !hasExactKeys(value, [
      "approvalRequirement",
      "capability",
      "credentialBindingId",
      "effect",
      "executionTarget",
      "limits",
      "recovery",
      "resourceBindingId",
    ]) ||
    !hasExactKeys(value.executionTarget, ["bindingId", "kind"]) ||
    !hasExactKeys(value.limits, [
      "maxArtifactBytes",
      "maxOutputBytes",
      "timeoutMs",
    ])
  ) {
    throw new Error("device_tool_policy_invalid");
  }
  return structuredClone(value) as ToolExecutionPolicy;
}

function readBoundedJson(
  path: string,
  maxBytes: number,
  code: string,
): unknown {
  try {
    return JSON.parse(readBoundedFile(path, maxBytes, code).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === code) {
      throw error;
    }
    throw new Error(code, { cause: error });
  }
}

function readBoundedFile(path: string, maxBytes: number, code: string): Buffer {
  const normalized = boundedPath(path);
  const metadata = statSync(normalized);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxBytes) {
    throw new Error(code);
  }
  const contents = readFileSync(normalized);
  if (contents.byteLength < 1 || contents.byteLength > maxBytes) {
    throw new Error(code);
  }
  return contents;
}

function boundedPath(value: unknown): string {
  const path = boundedString(value, 4_096, "device_tool_path_invalid");
  if (path.includes("\0") || !isAbsolute(path)) {
    throw new Error("device_tool_path_invalid");
  }
  return path;
}

function httpsEndpoint(value: unknown): string {
  const raw = boundedString(value, 2_048, "device_gateway_config_invalid");
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch (error) {
    throw new Error("device_gateway_config_invalid", { cause: error });
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (endpoint.pathname !== "" && endpoint.pathname !== "/")
  ) {
    throw new Error("device_gateway_config_invalid");
  }
  return new URL(endpoint.origin).toString().replace(/\/$/u, "");
}

function boundedString(
  value: unknown,
  maxLength: number,
  code: string,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function opaqueId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function toolKey(definition: ToolDefinition): string {
  return `${definition.kind}:${definition.name}`;
}

function isNativeRawReadDefinition(definition: ToolDefinition): boolean {
  if (
    definition.kind !== "function" ||
    definition.name !== "read_file" ||
    definition.execution !== "serial"
  ) {
    return false;
  }
  return stableJson(definition.inputSchema) === stableJson({
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: {
        const: "crewon.device-filesystem-read-arguments.v0",
      },
      workspaceIncarnationId: { type: "string" },
      relativePathSegments: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
      encoding: { const: "utf8" },
    },
    required: [
      "schemaVersion",
      "workspaceIncarnationId",
      "relativePathSegments",
      "encoding",
    ],
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
