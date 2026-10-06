import type {
  DesktopLocalPluginExecutionIdentity,
  DesktopLocalPluginExecutionPreview,
  DesktopLocalPluginExecutionResult,
  DesktopLocalPluginExecutionStatus,
} from "../desktop/desktopLocalPluginExecutionSetupProtocol";
import { parseDesktopProjectHistoricalQueriesConfiguration } from "@crewon/contracts/plugins";

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
  const withMediaInputs =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "mediaInputPreparation");
  const withMediaGenerations =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "mediaGenerationPreparation");
  const withHistory =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "historyQuery");
  const withAvailability =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "historyQueryAvailability");
  const fields = record(input, [
    ...executionIdentityKeys,
    "previewId",
    "expiresAt",
    "baseUrl",
    "preset",
    "networkPaths",
    "approvalRequirement",
    ...(withHistory ? ["historyQuery"] : []),
    ...(withMediaInputs ? ["mediaInputPreparation"] : []),
    ...(withMediaGenerations ? ["mediaGenerationPreparation"] : []),
    ...(withAvailability ? ["historyQueryAvailability"] : []),
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
  if (
    (withHistory && fields.historyQueryAvailability !== "available") ||
    (withAvailability &&
      fields.historyQueryAvailability !== "available" &&
      fields.historyQueryAvailability !== "unavailable") ||
    (fields.historyQueryAvailability === "available" && !withHistory)
  )
    invalid();
  const historyQuery = withHistory
    ? captureHistoricalQueryPreview(fields.historyQuery, expected)
    : undefined;
  const mediaInputPreparation = withMediaInputs
    ? captureMediaInputPreparation(fields.mediaInputPreparation)
    : undefined;
  const mediaGenerationPreparation = withMediaGenerations
    ? captureMediaGenerationPreparation(
        fields.mediaGenerationPreparation,
        mediaInputPreparation,
      )
    : undefined;
  return Object.freeze({
    ...expected,
    previewId: fields.previewId as string,
    expiresAt: fields.expiresAt,
    baseUrl: fields.baseUrl,
    preset: parameters.preset,
    approvalRequirement: "none",
    networkPaths: Object.freeze(paths),
    ...(historyQuery === undefined ? {} : { historyQuery }),
    ...(mediaInputPreparation ? { mediaInputPreparation } : {}),
    ...(mediaGenerationPreparation ? { mediaGenerationPreparation } : {}),
    ...(withAvailability
      ? {
          historyQueryAvailability: fields.historyQueryAvailability as
            | "available"
            | "unavailable",
        }
      : {}),
  });
}

function captureHistoricalQueryPreview(
  input: unknown,
  expected: DesktopLocalPluginExecutionIdentity,
): NonNullable<DesktopLocalPluginExecutionPreview["historyQuery"]> {
  const value = record(input, [
    "source",
    "target",
    "selectionRevision",
    "configurationRevision",
    "configurationDigest",
    "scope",
    "methods",
  ]);
  const parsed = parseDesktopProjectHistoricalQueriesConfiguration(
    {
      version: "crewon.desktop-project-historical-query.v1",
      publications: [{ source: value.source, target: value.target }],
    },
    {
      publications: [
        { pluginId: expected.pluginId, packageDigest: expected.packageDigest },
      ],
    },
  ).publications[0]!;
  if (
    parsed.source.pluginId !== expected.pluginId ||
    parsed.source.packageDigest !== expected.packageDigest ||
    parsed.source.contributionId !== "workbench" ||
    parsed.target.pluginId !== "crewon.comfyui-krea2" ||
    !Number.isSafeInteger(value.selectionRevision) ||
    (value.selectionRevision as number) < 1 ||
    !Number.isSafeInteger(value.configurationRevision) ||
    (value.configurationRevision as number) < 1 ||
    typeof value.configurationDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.configurationDigest) ||
    value.scope !== "query-existing-generations" ||
    !Array.isArray(value.methods) ||
    Object.getPrototypeOf(value.methods) !== Array.prototype ||
    value.methods.length !== 1 ||
    Reflect.ownKeys(value.methods).length !== 2
  )
    invalid();
  const method = Object.getOwnPropertyDescriptor(value.methods, "0");
  if (!method?.enumerable || !("value" in method) || method.value !== "GET")
    invalid();
  return Object.freeze({
    ...parsed,
    selectionRevision: value.selectionRevision as number,
    configurationRevision: value.configurationRevision as number,
    configurationDigest: value.configurationDigest,
    scope: "query-existing-generations",
    methods: Object.freeze(["GET"] as const),
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

function captureMediaInputPreparation(
  input: unknown,
): NonNullable<DesktopLocalPluginExecutionPreview["mediaInputPreparation"]> {
  const value = record(input, ["scope", "workflows"]);
  if (
    value.scope !== "read-write-inputs" ||
    !Array.isArray(value.workflows) ||
    Object.getPrototypeOf(value.workflows) !== Array.prototype ||
    value.workflows.length < 1 ||
    value.workflows.length > 2 ||
    Reflect.ownKeys(value.workflows).length !== value.workflows.length + 1
  )
    invalid();
  const workflows = Array.from(
    { length: value.workflows.length },
    (_, index) => {
      const d = Object.getOwnPropertyDescriptor(value.workflows, String(index));
      if (!d?.enumerable || !("value" in d)) invalid();
      const w = record(d.value, ["workflowId", "workflowDigest"]);
      if (
        (w.workflowId !== "krea2-reference-four-view" &&
          w.workflowId !== "flux2-three-reference-storyboard") ||
        typeof w.workflowDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(w.workflowDigest)
      )
        invalid();
      return Object.freeze({
        workflowId: w.workflowId as
          | "krea2-reference-four-view"
          | "flux2-three-reference-storyboard",
        workflowDigest: w.workflowDigest,
      });
    },
  );
  if (new Set(workflows.map((w) => w.workflowId)).size !== workflows.length)
    invalid();
  return Object.freeze({
    scope: "read-write-inputs",
    workflows: Object.freeze(workflows),
  });
}

function captureMediaGenerationPreparation(
  input: unknown,
  prepared: DesktopLocalPluginExecutionPreview["mediaInputPreparation"],
): NonNullable<
  DesktopLocalPluginExecutionPreview["mediaGenerationPreparation"]
> {
  const value = record(input, [
    "scope",
    "alreadyApproved",
    "workflows",
    "additionalNetworkPaths",
  ]);
  if (
    !prepared ||
    value.scope !== "generate-from-adopted-references" ||
    typeof value.alreadyApproved !== "boolean"
  )
    invalid();
  const { workflows } = captureMediaInputPreparation({
    scope: "read-write-inputs",
    workflows: value.workflows,
  });
  if (
    workflows.length !== prepared.workflows.length ||
    workflows.some(
      (w, i) =>
        w.workflowId !== prepared.workflows[i]!.workflowId ||
        w.workflowDigest !== prepared.workflows[i]!.workflowDigest,
    )
  )
    invalid();
  const paths = value.additionalNetworkPaths;
  if (
    !Array.isArray(paths) ||
    Object.getPrototypeOf(paths) !== Array.prototype ||
    paths.length !== 1 ||
    Reflect.ownKeys(paths).length !== 2
  )
    invalid();
  const path = Object.getOwnPropertyDescriptor(paths, "0");
  if (!path?.enumerable || !("value" in path)) invalid();
  const rule = record(path.value, ["method", "path"]);
  if (rule.method !== "POST" || rule.path !== "/upload/image") invalid();
  return Object.freeze({
    scope: "generate-from-adopted-references",
    alreadyApproved: value.alreadyApproved,
    workflows,
    additionalNetworkPaths: Object.freeze([
      Object.freeze({ method: "POST", path: "/upload/image" }),
    ] as const),
  });
}
