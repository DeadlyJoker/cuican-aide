import type {
  DesktopLocalPluginExecutionIdentity,
  DesktopLocalPluginExecutionPreview,
  DesktopLocalPluginExecutionResult,
  DesktopLocalPluginExecutionStatus,
} from "../desktop/desktopLocalPluginExecutionSetupProtocol";

export const executionIdentityKeys = [
  "pluginId",
  "publisherId",
  "version",
  "packageDigest",
  "manifestDigest",
  "implementationDigest",
  "selectionRevision",
  "configurationRevision",
  "configurationDigest",
] as const;
export type ExecutionSetupParameters = Readonly<{
  baseUrl: string;
  preset: DesktopLocalPluginExecutionPreview["preset"];
}>;

function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key))
  )
    invalid();
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      invalid();
    fields[key] = descriptor.value;
  }
  return fields;
}
function invalid(): never {
  throw new Error("desktop_plugin_execution_reply_invalid");
}
function opaque(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 256 ||
    /[\u0000-\u0020\u007f]/u.test(input)
  )
    invalid();
  return input;
}
function identity(
  fields: Record<string, unknown>,
  expected: DesktopLocalPluginExecutionIdentity,
): void {
  if (executionIdentityKeys.some((key) => fields[key] !== expected[key]))
    invalid();
}
export function sameExecutionIdentity(
  left: DesktopLocalPluginExecutionIdentity,
  right: DesktopLocalPluginExecutionIdentity,
): boolean {
  return executionIdentityKeys.every((key) => left[key] === right[key]);
}

/** Public replies cannot replace any selected package or saved configuration pin. */
export function captureExecutionSetupPreview(
  input: unknown,
  expected: DesktopLocalPluginExecutionIdentity,
  parameters: ExecutionSetupParameters,
  now = Date.now(),
): DesktopLocalPluginExecutionPreview {
  const fields = record(input, [
    ...executionIdentityKeys,
    "previewId",
    "expiresAt",
    "baseUrl",
    "preset",
    "networkPaths",
    "approvalRequirement",
  ]);
  identity(fields, expected);
  opaque(fields.previewId);
  if (
    typeof fields.expiresAt !== "number" ||
    !Number.isSafeInteger(fields.expiresAt) ||
    fields.expiresAt <= now ||
    fields.expiresAt > now + 300_000 ||
    typeof fields.baseUrl !== "string" ||
    fields.preset !== parameters.preset ||
    fields.approvalRequirement !== "none"
  )
    invalid();
  const url = new URL(parameters.baseUrl);
  const actualUrl = new URL(fields.baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    actualUrl.href !== url.href
  )
    invalid();
  const raw = fields.networkPaths;
  if (
    !Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Array.prototype ||
    raw.length < 1 ||
    raw.length > 32
  )
    invalid();
  const paths: DesktopLocalPluginExecutionPreview["networkPaths"][number][] =
    [];
  for (let index = 0; index < raw.length; index++) {
    const item = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!item?.enumerable || !Object.hasOwn(item, "value")) invalid();
    const rule = item.value as unknown;
    const prefix =
      rule &&
      typeof rule === "object" &&
      Object.hasOwn(rule, "operationPathPrefix");
    const value = record(rule, [
      "method",
      prefix ? "operationPathPrefix" : "path",
    ]);
    const path = value[prefix ? "operationPathPrefix" : "path"];
    if (
      typeof path !== "string" ||
      path.length > 256 ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\u0000-\u0020\u007f?#\\]/u.test(path) ||
      (prefix
        ? value.method !== "GET"
        : value.method !== "GET" && value.method !== "POST")
    )
      invalid();
    paths.push(
      Object.freeze(
        prefix
          ? { method: "GET" as const, operationPathPrefix: path }
          : { method: value.method as "GET" | "POST", path },
      ),
    );
  }
  return Object.freeze({
    ...expected,
    previewId: fields.previewId as string,
    expiresAt: fields.expiresAt,
    baseUrl: fields.baseUrl,
    preset: parameters.preset,
    approvalRequirement: "none",
    networkPaths: Object.freeze(paths),
  });
}

export function captureExecutionSetupResult(
  input: unknown,
  expected: DesktopLocalPluginExecutionIdentity,
): DesktopLocalPluginExecutionResult {
  const fields = record(input, [
    ...executionIdentityKeys,
    "state",
    "runtimeStatus",
    "stage",
  ]);
  identity(fields, expected);
  if (
    (fields.state !== "prepared" && fields.state !== "restartRequired") ||
    (fields.runtimeStatus !== "ready" &&
      fields.runtimeStatus !== "restartRequired") ||
    (fields.stage !== "policyCommitted" &&
      fields.stage !== "mappingCommitted") ||
    (fields.state === "prepared" &&
      (fields.runtimeStatus !== "ready" || fields.stage !== "mappingCommitted"))
  )
    invalid();
  return Object.freeze({
    ...expected,
    state: fields.state as DesktopLocalPluginExecutionResult["state"],
    runtimeStatus:
      fields.runtimeStatus as DesktopLocalPluginExecutionResult["runtimeStatus"],
    stage: fields.stage as DesktopLocalPluginExecutionResult["stage"],
  });
}

export function captureExecutionSetupStatus(
  input: unknown,
  expected: DesktopLocalPluginExecutionIdentity,
  previewId?: string,
): DesktopLocalPluginExecutionStatus | null {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const state = Object.getOwnPropertyDescriptor(input, "state");
  if (!state || !Object.hasOwn(state, "value")) invalid();
  const fields = record(input, [
    "previewId",
    "pluginId",
    "state",
    ...(state.value === "committed"
      ? ["result"]
      : state.value === "failed"
        ? ["code", "policyCommitted"]
        : []),
  ]);
  const id = opaque(fields.previewId);
  if (
    fields.pluginId !== expected.pluginId ||
    (previewId !== undefined && id !== previewId)
  )
    invalid();
  if (fields.state === "pending")
    return Object.freeze({
      previewId: id,
      pluginId: expected.pluginId,
      state: "pending",
    });
  if (fields.state === "committed")
    return Object.freeze({
      previewId: id,
      pluginId: expected.pluginId,
      state: "committed",
      result: captureExecutionSetupResult(fields.result, expected),
    });
  if (
    fields.state === "failed" &&
    fields.code === "desktop_plugin_execution_setup_failed" &&
    typeof fields.policyCommitted === "boolean"
  )
    return Object.freeze({
      previewId: id,
      pluginId: expected.pluginId,
      state: "failed",
      code: fields.code,
      policyCommitted: fields.policyCommitted,
    });
  return invalid();
}
