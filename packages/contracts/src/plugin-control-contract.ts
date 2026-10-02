import {
  parsePluginPackageDescriptor,
  type PluginPackageDescriptor,
} from "./plugin-package-contract.ts";
import {
  parsePluginUiJsonValue,
  type PluginUiJsonValue,
} from "./plugin-ui-json.ts";
import { parsePluginUiLease, type PluginUiLease } from "./plugin-ui-lease.ts";
import {
  copyPluginControlJson,
  pluginControlArray,
  pluginControlFail,
  pluginControlLimit,
  pluginControlOpaqueId,
  pluginControlRecord,
  pluginControlRevision,
  pluginControlTimestamp,
  pluginControlVersion,
} from "./plugin-control-contract-support.ts";

export const MAX_PLUGIN_CONTROL_RESPONSE_BYTES = 128 * 1024;
export const MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES = 512 * 1024;
export const MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_PLUGIN_UI_ASSET_BYTES = 32 * 1024 * 1024;

export type PluginPackageView = Readonly<{
  pluginId: string;
  version: string;
  publisherId: string;
  packageDigest: string;
  installedAt: string;
}>;
export type PluginSelectionView = Readonly<{
  pluginId: string;
  publisherId: string;
  revision: number;
  state: "enabled" | "disabled" | "uninstalled";
  selectedPackageDigest: string | null;
  updatedAt: string;
}>;
export type PluginPackageListQuery = Readonly<{
  pluginId: string | null;
  afterPackageDigest: string | null;
  limit: number;
}>;
export type PluginSelectionListQuery = Readonly<{
  afterPluginId: string | null;
  limit: number;
}>;
export type InstallPluginPackageRequest = Readonly<{
  sourceId: string;
  expectedPluginId: string;
  expectedPackageDigest: string;
  expectedSelectionRevision: number | null;
}>;
export type SelectPluginPackageRequest = Readonly<{
  state: PluginSelectionView["state"];
  selectedPackageDigest: string | null;
  expectedSelectionRevision: number;
}>;
export type OpenPluginUiMountRequest = Readonly<{
  pluginId: string;
  contributionId: string;
  expectedSelectionRevision: number;
  expectedPackageDigest: string;
}>;
export type InvokePluginUiActionRequest = Readonly<{
  action: string;
  input: PluginUiJsonValue;
}>;
export type PluginPackageListResponse = Readonly<{
  packages: readonly PluginPackageView[];
  next: string | null;
}>;
export type PluginSelectionListResponse = Readonly<{
  selections: readonly PluginSelectionView[];
  next: string | null;
}>;
export type GetPluginPackageResponse = Readonly<{
  package: PluginPackageView | null;
}>;
export type GetPluginSelectionResponse = Readonly<{
  selection: PluginSelectionView | null;
}>;
export type PluginInstallationResponse = Readonly<{
  kind: "install";
  disposition: "committed" | "replayed";
  package: PluginPackageView;
  selection: PluginSelectionView;
}>;
export type PluginSelectionResponse = Readonly<{
  mutation: Readonly<{
    kind: "select";
    disposition: "committed" | "replayed";
    selection: PluginSelectionView;
  }>;
  projection:
    | Readonly<{ outcome: "applied" | "unchanged" }>
    | Readonly<{ outcome: "pending"; reasonCode: "plugin_projection_pending" }>;
}>;
export type PluginUiCatalogItem = Readonly<{
  descriptor: PluginPackageDescriptor;
  publicAssets: readonly string[];
  selectionRevision: number;
  packageDigest: string;
}>;
export type PluginUiCatalogResponse = Readonly<{
  plugins: readonly PluginUiCatalogItem[];
  next: string | null;
}>;
export type OpenPluginUiMountResponse = PluginUiLease;
export type ValidatePluginUiMountResponse = PluginUiLease;
export type ClosePluginUiMountResponse = Readonly<{ closed: true }>;
export type InvokePluginUiActionResponse = Readonly<{
  output: PluginUiJsonValue;
}>;

export function parsePluginControlPluginId(input: unknown): string {
  if (typeof input !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(input))
    pluginControlFail("plugin_control_plugin_id_invalid");
  return input;
}
export function parsePluginControlPackageDigest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    pluginControlFail("plugin_control_package_digest_invalid");
  return input;
}
export function parsePluginControlMountRef(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(input))
    pluginControlFail("plugin_control_mount_ref_invalid");
  return input;
}
/** HTTP header token; internal ledger/source IDs retain their separate Unicode value rules. */
export function parsePluginControlIdempotencyKey(input: unknown): string {
  if (
    typeof input !== "string" ||
    input !== input.trim() ||
    !/^[!-~]{1,128}$/u.test(input)
  )
    pluginControlFail("plugin_control_idempotency_key_invalid");
  return input;
}
/** A decoded logical inventory path. URL decoding and actual files remain the transport/host's job. */
export function parsePluginControlAssetPath(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 256 ||
    new TextEncoder().encode(input).byteLength > 256 ||
    /[\\%:?#\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input) ||
    input
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    pluginControlFail("plugin_control_asset_path_invalid");
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      pluginControlFail("plugin_control_asset_path_invalid");
  }
  return input;
}
export function parsePluginControlEmptyQuery(
  input: unknown,
): Readonly<Record<string, never>> {
  pluginControlRecord(input, [], { query: true });
  return Object.freeze({});
}
export function parsePluginPackageListQuery(
  input: unknown,
): PluginPackageListQuery {
  const value = pluginControlRecord(
    input,
    ["pluginId", "afterPackageDigest", "limit"],
    { optional: ["pluginId", "afterPackageDigest", "limit"], query: true },
  );
  return Object.freeze({
    pluginId: Object.hasOwn(value, "pluginId")
      ? parsePluginControlPluginId(value.pluginId)
      : null,
    afterPackageDigest: Object.hasOwn(value, "afterPackageDigest")
      ? parsePluginControlPackageDigest(value.afterPackageDigest)
      : null,
    limit: queryLimit(value),
  });
}
export function parsePluginSelectionListQuery(
  input: unknown,
): PluginSelectionListQuery {
  const value = pluginControlRecord(input, ["afterPluginId", "limit"], {
    optional: ["afterPluginId", "limit"],
    query: true,
  });
  return Object.freeze({
    afterPluginId: Object.hasOwn(value, "afterPluginId")
      ? parsePluginControlPluginId(value.afterPluginId)
      : null,
    limit: queryLimit(value),
  });
}
export function parseInstallPluginPackageRequest(
  input: unknown,
): InstallPluginPackageRequest {
  const value = pluginControlRecord(input, [
    "sourceId",
    "expectedPluginId",
    "expectedPackageDigest",
    "expectedSelectionRevision",
  ]);
  return Object.freeze({
    sourceId: pluginControlOpaqueId(value.sourceId),
    expectedPluginId: parsePluginControlPluginId(value.expectedPluginId),
    expectedPackageDigest: parsePluginControlPackageDigest(
      value.expectedPackageDigest,
    ),
    expectedSelectionRevision:
      value.expectedSelectionRevision === null
        ? null
        : pluginControlRevision(value.expectedSelectionRevision),
  });
}
export function parseSelectPluginPackageRequest(
  input: unknown,
): SelectPluginPackageRequest {
  const value = pluginControlRecord(input, [
    "state",
    "selectedPackageDigest",
    "expectedSelectionRevision",
  ]);
  const selection = selectionState(value.state, value.selectedPackageDigest);
  return Object.freeze({
    ...selection,
    expectedSelectionRevision: pluginControlRevision(
      value.expectedSelectionRevision,
    ),
  });
}
export function parseOpenPluginUiMountRequest(
  input: unknown,
): OpenPluginUiMountRequest {
  const value = pluginControlRecord(input, [
    "pluginId",
    "contributionId",
    "expectedSelectionRevision",
    "expectedPackageDigest",
  ]);
  return Object.freeze({
    pluginId: parsePluginControlPluginId(value.pluginId),
    contributionId: parsePluginControlPluginId(value.contributionId),
    expectedSelectionRevision: pluginControlRevision(
      value.expectedSelectionRevision,
    ),
    expectedPackageDigest: parsePluginControlPackageDigest(
      value.expectedPackageDigest,
    ),
  });
}
export function parseInvokePluginUiActionRequest(
  input: unknown,
): InvokePluginUiActionRequest {
  const value = pluginControlRecord(input, ["action", "input"]);
  return Object.freeze({
    action: pluginControlOpaqueId(value.action),
    input: parsePluginUiJsonValue(value.input, { maxBytes: 24 * 1024 }),
  });
}
export function parsePluginPackageView(input: unknown): PluginPackageView {
  const value = pluginControlRecord(input, [
    "pluginId",
    "version",
    "publisherId",
    "packageDigest",
    "installedAt",
  ]);
  return Object.freeze({
    pluginId: parsePluginControlPluginId(value.pluginId),
    version: pluginControlVersion(value.version),
    publisherId: parsePluginControlPluginId(value.publisherId),
    packageDigest: parsePluginControlPackageDigest(value.packageDigest),
    installedAt: pluginControlTimestamp(value.installedAt),
  });
}
export function parsePluginSelectionView(input: unknown): PluginSelectionView {
  const value = pluginControlRecord(input, [
    "pluginId",
    "publisherId",
    "revision",
    "state",
    "selectedPackageDigest",
    "updatedAt",
  ]);
  return Object.freeze({
    pluginId: parsePluginControlPluginId(value.pluginId),
    publisherId: parsePluginControlPluginId(value.publisherId),
    revision: pluginControlRevision(value.revision),
    ...selectionState(value.state, value.selectedPackageDigest),
    updatedAt: pluginControlTimestamp(value.updatedAt),
  });
}
export function parsePluginPackageListResponse(
  input: unknown,
  context: PluginPackageListQuery,
): PluginPackageListResponse {
  const query = normalizedPackageQuery(context);
  const value = responseRecord(input, ["packages", "next"]);
  const packages = pluginControlArray(value.packages, query.limit).map(
    parsePluginPackageView,
  );
  const versions = new Set<string>();
  const publishers = new Map<string, string>();
  for (const pkg of packages) {
    const key = `${pkg.pluginId}@${pkg.version}`;
    if (
      versions.has(key) ||
      (publishers.has(pkg.pluginId) &&
        publishers.get(pkg.pluginId) !== pkg.publisherId)
    )
      pluginControlFail("plugin_control_package_identity_conflict");
    versions.add(key);
    publishers.set(pkg.pluginId, pkg.publisherId);
  }
  for (const pkg of packages)
    if (query.pluginId !== null && pkg.pluginId !== query.pluginId)
      pluginControlFail("plugin_control_response_context_mismatch");
  const next = pageCursor(
    value.next,
    packages.map((pkg) => pkg.packageDigest),
    query.afterPackageDigest,
    query.limit,
    parsePluginControlPackageDigest,
  );
  return Object.freeze({ packages: Object.freeze(packages), next });
}
export function parsePluginSelectionListResponse(
  input: unknown,
  context: PluginSelectionListQuery,
): PluginSelectionListResponse {
  const query = normalizedSelectionQuery(context);
  const value = responseRecord(input, ["selections", "next"]);
  const selections = pluginControlArray(value.selections, query.limit).map(
    parsePluginSelectionView,
  );
  const next = pageCursor(
    value.next,
    selections.map((item) => item.pluginId),
    query.afterPluginId,
    query.limit,
    parsePluginControlPluginId,
  );
  return Object.freeze({ selections: Object.freeze(selections), next });
}
export function parseGetPluginPackageResponse(
  input: unknown,
  context: Readonly<{ packageDigest: string }>,
): GetPluginPackageResponse {
  const digest = parsePluginControlPackageDigest(
    pluginControlRecord(context, ["packageDigest"]).packageDigest,
  );
  const value = responseRecord(input, ["package"]);
  const pkg =
    value.package === null ? null : parsePluginPackageView(value.package);
  if (pkg !== null && pkg.packageDigest !== digest)
    pluginControlFail("plugin_control_response_context_mismatch");
  return Object.freeze({ package: pkg });
}
export function parseGetPluginSelectionResponse(
  input: unknown,
  context: Readonly<{ pluginId: string }>,
): GetPluginSelectionResponse {
  const id = parsePluginControlPluginId(
    pluginControlRecord(context, ["pluginId"]).pluginId,
  );
  const value = responseRecord(input, ["selection"]);
  const selection =
    value.selection === null ? null : parsePluginSelectionView(value.selection);
  if (selection !== null && selection.pluginId !== id)
    pluginControlFail("plugin_control_response_context_mismatch");
  return Object.freeze({ selection });
}
export function parsePluginInstallationResponse(
  input: unknown,
  context: InstallPluginPackageRequest,
): PluginInstallationResponse {
  const request = parseInstallPluginPackageRequest(context);
  const value = responseRecord(input, [
    "kind",
    "disposition",
    "package",
    "selection",
  ]);
  if (value.kind !== "install") pluginControlFail();
  const pkg = parsePluginPackageView(value.package);
  const selection = parsePluginSelectionView(value.selection);
  if (
    pkg.pluginId !== request.expectedPluginId ||
    pkg.packageDigest !== request.expectedPackageDigest ||
    selection.pluginId !== pkg.pluginId ||
    selection.publisherId !== pkg.publisherId
  )
    pluginControlFail("plugin_control_response_context_mismatch");
  if (request.expectedSelectionRevision === null) {
    if (
      selection.revision !== 1 ||
      selection.state !== "disabled" ||
      selection.selectedPackageDigest !== pkg.packageDigest
    )
      pluginControlFail("plugin_control_response_context_mismatch");
  } else if (selection.revision === request.expectedSelectionRevision) {
    if (selection.state === "uninstalled")
      pluginControlFail("plugin_control_response_context_mismatch");
  } else if (
    selection.revision !== request.expectedSelectionRevision + 1 ||
    selection.state !== "disabled" ||
    selection.selectedPackageDigest !== pkg.packageDigest
  )
    pluginControlFail("plugin_control_response_context_mismatch");
  return Object.freeze({
    kind: "install",
    disposition: disposition(value.disposition),
    package: pkg,
    selection,
  });
}
export function parsePluginSelectionResponse(
  input: unknown,
  context: Readonly<{ pluginId: string; request: SelectPluginPackageRequest }>,
): PluginSelectionResponse {
  const args = pluginControlRecord(context, ["pluginId", "request"]);
  const pluginId = parsePluginControlPluginId(args.pluginId);
  const request = parseSelectPluginPackageRequest(args.request);
  const value = responseRecord(input, ["mutation", "projection"]);
  const mutation = pluginControlRecord(value.mutation, [
    "kind",
    "disposition",
    "selection",
  ]);
  if (mutation.kind !== "select") pluginControlFail();
  const selection = parsePluginSelectionView(mutation.selection);
  if (
    selection.pluginId !== pluginId ||
    selection.revision !== request.expectedSelectionRevision + 1 ||
    selection.state !== request.state ||
    selection.selectedPackageDigest !== request.selectedPackageDigest
  )
    pluginControlFail("plugin_control_response_context_mismatch");
  const parsedDisposition = disposition(mutation.disposition);
  const projection = projectionValue(value.projection);
  if (
    (parsedDisposition === "replayed") !==
    (projection.outcome === "unchanged")
  )
    pluginControlFail("plugin_control_response_context_mismatch");
  return Object.freeze({
    mutation: Object.freeze({
      kind: "select",
      disposition: parsedDisposition,
      selection,
    }),
    projection,
  });
}
export function parsePluginUiCatalogResponse(
  input: unknown,
  context: PluginSelectionListQuery,
): PluginUiCatalogResponse {
  const query = normalizedSelectionQuery(context);
  const value = pluginControlRecord(
    copyPluginControlJson(input, {
      maxBytes: MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES,
      maxNodes: 512000,
    }),
    ["plugins", "next"],
  );
  const plugins = pluginControlArray(value.plugins, query.limit).map(
    parseCatalogItem,
  );
  let previous = query.afterPluginId;
  for (const item of plugins) {
    if (previous !== null && item.descriptor.pluginId <= previous)
      pluginControlFail("plugin_control_page_order_invalid");
    previous = item.descriptor.pluginId;
  }
  const next =
    value.next === null ? null : parsePluginControlPluginId(value.next);
  // The cursor belongs to the underlying selection page, including filtered disabled/unsupported items.
  if (
    next !== null &&
    ((query.afterPluginId !== null && next <= query.afterPluginId) ||
      (previous !== null && next < previous))
  )
    pluginControlFail("plugin_control_page_cursor_invalid");
  return Object.freeze({ plugins: Object.freeze(plugins), next });
}
export function parseOpenPluginUiMountResponse(
  input: unknown,
  context: OpenPluginUiMountRequest,
): OpenPluginUiMountResponse {
  const request = parseOpenPluginUiMountRequest(context);
  const lease = boundedLease(input);
  if (
    lease.descriptor.pluginId !== request.pluginId ||
    lease.contributionId !== request.contributionId ||
    lease.selectionRevision !== request.expectedSelectionRevision ||
    lease.packageDigest !== request.expectedPackageDigest
  )
    pluginControlFail("plugin_control_response_context_mismatch");
  return lease;
}
export function parseValidatePluginUiMountResponse(
  input: unknown,
  context: Readonly<{ mountRef: string }>,
): ValidatePluginUiMountResponse {
  const mountRef = parsePluginControlMountRef(
    pluginControlRecord(context, ["mountRef"]).mountRef,
  );
  const lease = boundedLease(input);
  if (lease.mountRef !== mountRef)
    pluginControlFail("plugin_control_response_context_mismatch");
  return lease;
}
export function parseClosePluginUiMountResponse(
  input: unknown,
): ClosePluginUiMountResponse {
  const value = responseRecord(input, ["closed"]);
  if (value.closed !== true) pluginControlFail();
  return Object.freeze({ closed: true });
}
export function parseInvokePluginUiActionResponse(
  input: unknown,
): InvokePluginUiActionResponse {
  const value = responseRecord(input, ["output"]);
  return Object.freeze({ output: parsePluginUiJsonValue(value.output) });
}

function queryLimit(value: Readonly<Record<string, unknown>>): number {
  if (!Object.hasOwn(value, "limit")) return 20;
  if (typeof value.limit !== "string" || !/^[1-9][0-9]?$/u.test(value.limit))
    pluginControlFail("plugin_control_limit_invalid");
  return pluginControlLimit(Number(value.limit));
}
function normalizedPackageQuery(
  input: PluginPackageListQuery,
): PluginPackageListQuery {
  const value = pluginControlRecord(input, [
    "pluginId",
    "afterPackageDigest",
    "limit",
  ]);
  return Object.freeze({
    pluginId:
      value.pluginId === null
        ? null
        : parsePluginControlPluginId(value.pluginId),
    afterPackageDigest:
      value.afterPackageDigest === null
        ? null
        : parsePluginControlPackageDigest(value.afterPackageDigest),
    limit: pluginControlLimit(value.limit),
  });
}
function normalizedSelectionQuery(
  input: PluginSelectionListQuery,
): PluginSelectionListQuery {
  const value = pluginControlRecord(input, ["afterPluginId", "limit"]);
  return Object.freeze({
    afterPluginId:
      value.afterPluginId === null
        ? null
        : parsePluginControlPluginId(value.afterPluginId),
    limit: pluginControlLimit(value.limit),
  });
}
function selectionState(
  state: unknown,
  digest: unknown,
): Pick<PluginSelectionView, "state" | "selectedPackageDigest"> {
  if (state !== "enabled" && state !== "disabled" && state !== "uninstalled")
    pluginControlFail();
  if ((state === "uninstalled") !== (digest === null))
    pluginControlFail("plugin_control_selection_digest_invalid");
  return Object.freeze({
    state,
    selectedPackageDigest:
      digest === null ? null : parsePluginControlPackageDigest(digest),
  });
}
function disposition(input: unknown): "committed" | "replayed" {
  if (input !== "committed" && input !== "replayed") pluginControlFail();
  return input;
}
function responseRecord(input: unknown, fields: readonly string[]) {
  return pluginControlRecord(
    copyPluginControlJson(input, {
      maxBytes: MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
    }),
    fields,
  );
}
function pageCursor(
  input: unknown,
  keys: readonly string[],
  after: string | null,
  limit: number,
  parser: (input: unknown) => string,
): string | null {
  let previous = after;
  for (const key of keys) {
    if (previous !== null && key <= previous)
      pluginControlFail("plugin_control_page_order_invalid");
    previous = key;
  }
  if (input === null) return null;
  const next = parser(input);
  if (keys.length !== limit || next !== previous)
    pluginControlFail("plugin_control_page_cursor_invalid");
  return next;
}
function projectionValue(
  input: unknown,
): PluginSelectionResponse["projection"] {
  const field =
    input !== null && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "outcome")
      : undefined;
  if (!field || !Object.hasOwn(field, "value")) pluginControlFail();
  if (field.value === "pending") {
    const value = pluginControlRecord(input, ["outcome", "reasonCode"]);
    if (value.reasonCode !== "plugin_projection_pending") pluginControlFail();
    return Object.freeze({
      outcome: "pending",
      reasonCode: "plugin_projection_pending",
    });
  }
  const value = pluginControlRecord(input, ["outcome"]);
  if (value.outcome !== "applied" && value.outcome !== "unchanged")
    pluginControlFail();
  return Object.freeze({ outcome: value.outcome });
}
function boundedLease(input: unknown): PluginUiLease {
  return parsePluginUiLease(
    copyPluginControlJson(input, {
      maxBytes: MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES,
      maxNodes: 16384,
    }),
  );
}
function parseCatalogItem(input: unknown): PluginUiCatalogItem {
  const value = pluginControlRecord(input, [
    "descriptor",
    "publicAssets",
    "selectionRevision",
    "packageDigest",
  ]);
  const descriptor = parsePluginPackageDescriptor(value.descriptor);
  const contribution = descriptor.contributions.find(
    (item) => item.kind === "module" && item.slot === "main.content",
  );
  if (!contribution)
    pluginControlFail("plugin_control_ui_contribution_unsupported");
  // Reuse the authoritative lease asset/entry/descriptor validation. These shape-only placeholders
  // are never returned as references or used to assert authorization or a current expiry.
  const checked = parsePluginUiLease({
    schemaVersion: "crewon.plugin-ui-lease.v1",
    mountRef: "c".repeat(32),
    expiresAt: "2000-01-01T00:00:00.000Z",
    descriptor,
    contributionId: contribution.id,
    publicAssets: value.publicAssets,
    selectionRevision: value.selectionRevision,
    packageDigest: value.packageDigest,
  });
  return Object.freeze({
    descriptor: checked.descriptor,
    publicAssets: checked.publicAssets,
    selectionRevision: checked.selectionRevision,
    packageDigest: checked.packageDigest,
  });
}
