import { ContractValidationError } from "./contract-validation-error.ts";

/** Package metadata only: parsing does not install, execute or authorize a plugin. */
export const PLUGIN_PACKAGE_SCHEMA_VERSION = "crewon.plugin-package.v1";
export const PLUGIN_PACKAGE_HOST_API = "crewon.plugin-host.v1";
export const PLUGIN_PACKAGE_DESCRIPTOR_PATH = "crewon.plugin.json";
export const PLUGIN_PACKAGE_LIMITS = Object.freeze({
  descriptorBytes: 256 * 1024,
  jsonNodes: 8192,
  jsonDepth: 16,
  files: 512,
  requirements: 64,
  provisions: 64,
  contributions: 64,
  identifierCharacters: 128,
  versionCharacters: 128,
  titleScalars: 160,
  descriptionBytes: 8192,
  pathBytes: 256,
});

export type PluginPackageEntrypoints = Readonly<{
  node: string | null;
  ui: Readonly<{
    path: string;
    mode: "trustedModule" | "isolatedWeb";
  }> | null;
}>;
export type PluginServiceRequirement = Readonly<{
  service: string;
  /** Opaque service protocol identifier; metadata does not prove compatibility. */
  apiVersion: string;
  optional: boolean;
}>;
export type PluginServiceProvision = Readonly<{
  service: string;
  /** Opaque service protocol identifier; metadata does not prove an implementation exists. */
  apiVersion: string;
}>;
export const PLUGIN_NAVIGATION_ICONS = Object.freeze([
  "book-open",
  "film",
  "image",
  "folder",
  "layout",
  "puzzle",
] as const);
export type PluginNavigationIcon = (typeof PLUGIN_NAVIGATION_ICONS)[number];
export type PluginUiSurface = "workbench" | "sidebar";

export type PluginUiContribution = Readonly<{
  /** Unique within this plugin; it conveys no host registration authority. */
  id: string;
  title: string;
  /** Host-rendered glyph only; no URLs, SVG or executable icon content. */
  icon?: PluginNavigationIcon;
  /** Optional host surfaces. Legacy modules remain workbench-only. */
  surfaces?: readonly PluginUiSurface[];
}> &
  (
    | Readonly<{ kind: "module"; slot: "main.content" }>
    | Readonly<{ kind: "settings"; slot: "settings.section" }>
    | Readonly<{ kind: "result"; slot: "result.view" }>
  );
export type PluginPackageFile = Readonly<{
  path: string;
  byteLength: number;
  /** Declared SHA-256, encoded as 64 lowercase hexadecimal characters. */
  sha256: string;
}>;
export type PluginPackageDescriptor = Readonly<{
  schemaVersion: typeof PLUGIN_PACKAGE_SCHEMA_VERSION;
  hostApi: typeof PLUGIN_PACKAGE_HOST_API;
  pluginId: string;
  version: string;
  title: string;
  description: string;
  publisherId: string;
  entrypoints: PluginPackageEntrypoints;
  /** Separate business manifest; its schema and contents are not parsed here. */
  businessManifestPath: string | null;
  requires: readonly PluginServiceRequirement[];
  provides: readonly PluginServiceProvision[];
  contributions: readonly PluginUiContribution[];
  /** All declared artifacts except the descriptor itself; actual bytes require later verification. */
  files: readonly PluginPackageFile[];
}>;

export class PluginPackageContractError extends ContractValidationError {
  constructor(code: string) {
    super(code);
    this.name = "PluginPackageContractError";
  }
}

/** Validates and freezes a detached descriptor without reading files or resolving services. */
export function parsePluginPackageDescriptor(
  input: unknown,
): PluginPackageDescriptor {
  const value = record(copyJson(input), [
    "schemaVersion",
    "hostApi",
    "pluginId",
    "version",
    "title",
    "description",
    "publisherId",
    "entrypoints",
    "businessManifestPath",
    "requires",
    "provides",
    "contributions",
    "files",
  ]);
  if (value.schemaVersion !== PLUGIN_PACKAGE_SCHEMA_VERSION)
    fail("plugin_package_schema_unsupported");
  if (value.hostApi !== PLUGIN_PACKAGE_HOST_API)
    fail("plugin_package_host_api_unsupported");

  const entrypoints = parseEntrypoints(value.entrypoints);
  const businessManifestPath =
    value.businessManifestPath === null
      ? null
      : packagePath(value.businessManifestPath);
  if (businessManifestPath !== null && !businessManifestPath.endsWith(".json"))
    fail("plugin_package_business_manifest_path_invalid");
  const requirements = array(
    value.requires,
    0,
    PLUGIN_PACKAGE_LIMITS.requirements,
  ).map(parseRequirement);
  unique(
    requirements.map((item) => item.service),
    "plugin_package_service_conflict",
  );
  const provisions = array(
    value.provides,
    0,
    PLUGIN_PACKAGE_LIMITS.provisions,
  ).map(parseProvision);
  unique(
    provisions.map((item) => item.service),
    "plugin_package_service_conflict",
  );
  const providedServices = new Set(provisions.map((item) => item.service));
  if (requirements.some((item) => providedServices.has(item.service)))
    fail("plugin_package_service_self_dependency");
  const contributions = array(
    value.contributions,
    0,
    PLUGIN_PACKAGE_LIMITS.contributions,
  ).map(parseContribution);
  unique(
    contributions.map((item) => item.id),
    "plugin_package_contribution_conflict",
  );
  if (contributions.length > 0 && entrypoints.ui === null)
    fail("plugin_package_ui_entrypoint_missing");
  if (entrypoints.ui !== null && contributions.length === 0)
    fail("plugin_package_ui_contribution_missing");
  const files = array(value.files, 1, PLUGIN_PACKAGE_LIMITS.files).map(
    parseFile,
  );
  assertInventoryPaths(files);
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.byteLength;
    if (!Number.isSafeInteger(totalBytes))
      fail("plugin_package_file_size_overflow");
  }
  const inventory = new Map(files.map((file) => [file.path, file]));
  for (const path of [entrypoints.node, entrypoints.ui?.path ?? null]) {
    if (path === null) continue;
    const file = inventory.get(path);
    if (!file) fail("plugin_package_artifact_missing");
    if (file.byteLength === 0) fail("plugin_package_entrypoint_empty");
  }
  if (businessManifestPath !== null && !inventory.has(businessManifestPath))
    fail("plugin_package_artifact_missing");
  const version = text(value.version, PLUGIN_PACKAGE_LIMITS.versionCharacters);
  if (
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      version,
    )
  )
    fail("plugin_package_version_invalid");
  return Object.freeze({
    schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
    hostApi: PLUGIN_PACKAGE_HOST_API,
    pluginId: identifier(value.pluginId),
    version,
    title: title(value.title),
    description: text(
      value.description,
      PLUGIN_PACKAGE_LIMITS.descriptionBytes,
    ),
    publisherId: identifier(value.publisherId),
    entrypoints,
    businessManifestPath,
    requires: Object.freeze(requirements),
    provides: Object.freeze(provisions),
    contributions: Object.freeze(contributions),
    files: Object.freeze(files),
  });
}

function parseEntrypoints(input: unknown): PluginPackageEntrypoints {
  const value = record(input, ["node", "ui"]);
  const node = value.node === null ? null : modulePath(value.node);
  let ui: PluginPackageEntrypoints["ui"] = null;
  if (value.ui !== null) {
    const entry = record(value.ui, ["path", "mode"]);
    if (entry.mode !== "trustedModule" && entry.mode !== "isolatedWeb")
      fail("plugin_package_ui_mode_invalid");
    const path =
      entry.mode === "trustedModule"
        ? modulePath(entry.path)
        : packagePath(entry.path);
    if (entry.mode === "isolatedWeb" && !path.endsWith(".html"))
      fail("plugin_package_ui_path_invalid");
    ui = Object.freeze({ path, mode: entry.mode });
  }
  if (node === null && ui === null) fail("plugin_package_entrypoint_missing");
  return Object.freeze({ node, ui });
}
function parseRequirement(input: unknown): PluginServiceRequirement {
  const value = record(input, ["service", "apiVersion", "optional"]);
  if (typeof value.optional !== "boolean")
    fail("plugin_package_requirement_invalid");
  return Object.freeze({
    service: identifier(value.service),
    apiVersion: serviceApiVersion(value.apiVersion),
    optional: value.optional,
  });
}
function parseProvision(input: unknown): PluginServiceProvision {
  const value = record(input, ["service", "apiVersion"]);
  return Object.freeze({
    service: identifier(value.service),
    apiVersion: serviceApiVersion(value.apiVersion),
  });
}
function parseContribution(input: unknown): PluginUiContribution {
  const hasIcon =
    input !== null && typeof input === "object" && Object.hasOwn(input, "icon");
  const hasSurfaces =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "surfaces");
  const value = record(input, [
    "id",
    "kind",
    "slot",
    "title",
    ...(hasIcon ? ["icon"] : []),
    ...(hasSurfaces ? ["surfaces"] : []),
  ]);
  if (
    hasIcon &&
    !PLUGIN_NAVIGATION_ICONS.includes(value.icon as PluginNavigationIcon)
  )
    fail("plugin_package_navigation_icon_invalid");
  let surfaces: readonly PluginUiSurface[] | undefined;
  if (hasSurfaces) {
    const requested = array(value.surfaces, 1, 2);
    if (
      value.kind !== "module" ||
      !requested.includes("workbench") ||
      new Set(requested).size !== requested.length ||
      requested.some(
        (surface) => surface !== "workbench" && surface !== "sidebar",
      )
    )
      fail("plugin_package_ui_surfaces_invalid");
    surfaces = Object.freeze([...requested] as PluginUiSurface[]);
  }
  const common = {
    id: identifier(value.id),
    title: title(value.title),
    ...(hasIcon ? { icon: value.icon as PluginNavigationIcon } : {}),
    ...(surfaces ? { surfaces } : {}),
  };
  if (value.kind === "module" && value.slot === "main.content")
    return Object.freeze({ ...common, kind: value.kind, slot: value.slot });
  if (value.kind === "settings" && value.slot === "settings.section")
    return Object.freeze({ ...common, kind: value.kind, slot: value.slot });
  if (value.kind === "result" && value.slot === "result.view")
    return Object.freeze({ ...common, kind: value.kind, slot: value.slot });
  fail("plugin_package_contribution_invalid");
}
function parseFile(input: unknown): PluginPackageFile {
  const value = record(input, ["path", "byteLength", "sha256"]);
  if (
    typeof value.byteLength !== "number" ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    Object.is(value.byteLength, -0)
  )
    fail("plugin_package_file_size_invalid");
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256))
    fail("plugin_package_file_digest_invalid");
  const path = packagePath(value.path);
  if (path === PLUGIN_PACKAGE_DESCRIPTOR_PATH)
    fail("plugin_package_descriptor_self_reference");
  return Object.freeze({
    path,
    byteLength: value.byteLength,
    sha256: value.sha256,
  });
}
function modulePath(input: unknown): string {
  const path = packagePath(input);
  if (!/\.(?:mjs|js)$/u.test(path)) fail("plugin_package_module_path_invalid");
  return path;
}
/** Each inventory item and the fixed descriptor are files, never parent directories. */
function assertInventoryPaths(files: readonly PluginPackageFile[]): void {
  const paths = files.map((file) => file.path);
  unique(paths, "plugin_package_file_conflict");
  const declaredFiles = new Set([PLUGIN_PACKAGE_DESCRIPTOR_PATH, ...paths]);
  for (const path of paths) {
    for (
      let index = path.indexOf("/");
      index !== -1;
      index = path.indexOf("/", index + 1)
    ) {
      if (declaredFiles.has(path.slice(0, index)))
        fail("plugin_package_file_conflict");
    }
  }
}
function packagePath(input: unknown): string {
  const path = text(input, PLUGIN_PACKAGE_LIMITS.pathBytes);
  if (/[\\%:?#\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path))
    fail("plugin_package_path_invalid");
  const segments = path.split("/");
  if (segments.some((part) => part === "" || part === "." || part === ".."))
    fail("plugin_package_path_invalid");
  return path;
}
function identifier(input: unknown): string {
  const value = text(input, PLUGIN_PACKAGE_LIMITS.identifierCharacters);
  if (!/^[a-z][a-z0-9._-]*$/u.test(value))
    fail("plugin_package_identifier_invalid");
  return value;
}
function serviceApiVersion(input: unknown): string {
  const value = text(input, PLUGIN_PACKAGE_LIMITS.identifierCharacters);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value))
    fail("plugin_package_service_api_version_invalid");
  return value;
}
function title(input: unknown): string {
  const value = text(input, PLUGIN_PACKAGE_LIMITS.titleScalars * 4);
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) fail("plugin_package_title_invalid");
  let scalars = 0;
  for (const _ of value) {
    if (++scalars > PLUGIN_PACKAGE_LIMITS.titleScalars)
      fail("plugin_package_title_invalid");
  }
  return value;
}
function text(input: unknown, maximumBytes: number): string {
  if (
    typeof input !== "string" ||
    !input ||
    input.length > maximumBytes ||
    input !== input.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}]/u.test(input) ||
    new TextEncoder().encode(input).byteLength > maximumBytes
  )
    fail("plugin_package_text_invalid");
  return input;
}
function record(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("plugin_package_object_invalid");
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value);
  if (
    actual.length !== fields.length ||
    actual.some((key) => !fields.includes(key))
  )
    fail("plugin_package_fields_invalid");
  return value;
}
function array(
  input: unknown,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(input) || input.length < minimum || input.length > maximum)
    fail("plugin_package_collection_invalid");
  return input;
}
function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code);
}

/** Descriptor-only, bounded JSON copy: no getter, toJSON or iterator is executed. */
function copyJson(input: unknown): unknown {
  const encoder = new TextEncoder();
  let nodes = 0;
  let rawBytes = 0;
  const ancestors = new WeakSet<object>();
  const string = (value: string): string => {
    if (value.length > PLUGIN_PACKAGE_LIMITS.descriptorBytes)
      fail("plugin_package_json_limit");
    rawBytes += encoder.encode(value).byteLength;
    if (rawBytes > PLUGIN_PACKAGE_LIMITS.descriptorBytes)
      fail("plugin_package_json_limit");
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          fail("plugin_package_json_invalid");
      } else if (unit >= 0xdc00 && unit <= 0xdfff)
        fail("plugin_package_json_invalid");
    }
    return value;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (
      ++nodes > PLUGIN_PACKAGE_LIMITS.jsonNodes ||
      depth > PLUGIN_PACKAGE_LIMITS.jsonDepth
    )
      fail("plugin_package_json_limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return string(value);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value === null || typeof value !== "object" || ancestors.has(value))
      fail("plugin_package_json_invalid");
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      isArray
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      fail("plugin_package_json_invalid");
    const names = Object.getOwnPropertyNames(value);
    if (names.length > PLUGIN_PACKAGE_LIMITS.jsonNodes)
      fail("plugin_package_json_limit");
    if (Object.getOwnPropertySymbols(value).length > 0)
      fail("plugin_package_json_invalid");
    const ownValue = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        fail("plugin_package_json_invalid");
      return descriptor.value;
    };
    ancestors.add(value);
    let result: unknown;
    if (isArray) {
      const length = Object.getOwnPropertyDescriptor(value, "length")
        ?.value as unknown;
      if (
        typeof length !== "number" ||
        length > PLUGIN_PACKAGE_LIMITS.jsonNodes ||
        names.length !== length + 1
      )
        fail("plugin_package_json_invalid");
      result = Object.freeze(
        Array.from({ length }, (_, index) =>
          visit(ownValue(String(index)), depth + 1),
        ),
      );
    } else {
      result = Object.freeze(
        Object.fromEntries(
          names
            .sort()
            .map((key) => [string(key), visit(ownValue(key), depth + 1)]),
        ),
      );
    }
    ancestors.delete(value);
    return result;
  };
  const copied = visit(input, 0);
  if (
    encoder.encode(JSON.stringify(copied)).byteLength >
    PLUGIN_PACKAGE_LIMITS.descriptorBytes
  )
    fail("plugin_package_json_limit");
  return copied;
}
function fail(code: string): never {
  throw new PluginPackageContractError(code);
}
