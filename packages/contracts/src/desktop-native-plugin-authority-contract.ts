import { ContractValidationError } from "./contract-validation-error.ts";
import {
  copyPluginControlJson,
  pluginControlRecord,
  pluginControlVersion,
} from "./plugin-control-contract-support.ts";
import {
  peerActor,
  peerDigest,
  peerOpaque,
  peerScope,
} from "./installed-plugin-peer-values.ts";
import type {
  InstalledPluginPeerActor,
  InstalledPluginPeerScope,
} from "./installed-plugin-peer-types.ts";

export const DESKTOP_NATIVE_PLUGIN_AUTHORITY_SCHEMA =
  "crewon.desktop-native-plugin-authority.v1";
export const DESKTOP_NATIVE_PLUGIN_AUTHORITY_MAX_BYTES = 128 * 1024;
/** Shared bound for persisted approvals and bootstrap catalogues across Main, Control and Worker. */
export const DESKTOP_PLUGIN_APPROVAL_MAX_BYTES = 256 * 1024;
export type DesktopNativePluginPackageIdentity = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
}>;
export type DesktopNativePluginNetworkPath =
  | Readonly<{ method: "GET" | "POST"; path: string }>
  /** A canonical path or single query value prefix, followed by the saved operation ID only. */
  | Readonly<{ method: "GET"; operationPathPrefix: string }>;

export function isPluginOperationPathPrefix(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\#\s\p{Cc}]/u.test(value)
  )
    return false;
  const url = new URL(value, "https://operation.invalid/");
  return (
    url.origin === "https://operation.invalid" &&
    url.pathname + url.search === value &&
    (url.search === ""
      ? value.endsWith("/")
      : /^\?[A-Za-z][A-Za-z0-9_]{0,63}=$/u.test(url.search))
  );
}
export type DesktopNativePluginNetworkGrant =
  DesktopNativePluginPackageIdentity &
    Readonly<{
      baseUrl: string;
      baseUrlParameter: string;
      paths: readonly DesktopNativePluginNetworkPath[];
    }>;
export type DesktopNativePluginAuthority = Readonly<{
  schemaVersion: typeof DESKTOP_NATIVE_PLUGIN_AUTHORITY_SCHEMA;
  authorityId: string;
  actor: InstalledPluginPeerActor;
  scope: InstalledPluginPeerScope;
  installRoot: string;
  controlDatabasePath: string;
  bootstrapPath: string;
  bootstrapDigest: string;
  approvalPath: string;
  approvalDigest: string;
  policyPath: string;
  policyDigest: string;
  profilePath: string;
  profileDigest: string;
  packages: readonly DesktopNativePluginPackageIdentity[];
  networkGrants: readonly DesktopNativePluginNetworkGrant[];
}>;
function invalid(): never {
  throw new ContractValidationError("desktop_native_plugin_authority_invalid");
}
function path(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 4096 ||
    !input.startsWith("/") ||
    input !== input.trim() ||
    /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input) ||
    input
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..")
  )
    invalid();
  return input;
}
function namespace(input: unknown): string {
  const value = peerOpaque(input);
  if (!/^[a-z][a-z0-9._-]*$/u.test(value)) invalid();
  return value;
}
function identity(input: unknown): DesktopNativePluginPackageIdentity {
  const value = pluginControlRecord(input, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ]);
  return Object.freeze({
    pluginId: namespace(value.pluginId),
    publisherId: namespace(value.publisherId),
    version: pluginControlVersion(value.version),
    packageDigest: peerDigest(value.packageDigest),
  });
}
function networkPath(input: unknown): DesktopNativePluginNetworkPath {
  if (!input || typeof input !== "object") invalid();
  const prefix = Object.getOwnPropertyDescriptor(
    input,
    "operationPathPrefix",
  )?.value;
  const value = pluginControlRecord(
    input,
    prefix === undefined
      ? ["method", "path"]
      : ["method", "operationPathPrefix"],
  );
  const text = prefix === undefined ? value.path : value.operationPathPrefix;
  if (
    typeof text !== "string" ||
    text.length > 2048 ||
    !text.startsWith("/") ||
    text.startsWith("//") ||
    /[\\#\s\p{Cc}]/u.test(text)
  )
    invalid();
  const url = new URL(text, "https://native.invalid/");
  if (
    url.origin !== "https://native.invalid" ||
    url.pathname + url.search !== text
  )
    invalid();
  if (prefix !== undefined) {
    if (value.method !== "GET" || !isPluginOperationPathPrefix(text)) invalid();
    return Object.freeze({ method: "GET", operationPathPrefix: text });
  }
  if (value.method !== "GET" && value.method !== "POST") invalid();
  return Object.freeze({ method: value.method, path: text });
}
/** Bounded Native policy DTO. Parsing does not issue filesystem ownership or install permission. */
export function parseDesktopNativePluginAuthority(
  input: unknown,
): DesktopNativePluginAuthority {
  try {
    const value = pluginControlRecord(
      copyPluginControlJson(input, {
        maxBytes: DESKTOP_NATIVE_PLUGIN_AUTHORITY_MAX_BYTES,
        maxNodes: 8192,
      }),
      [
        "schemaVersion",
        "authorityId",
        "actor",
        "scope",
        "installRoot",
        "controlDatabasePath",
        "bootstrapPath",
        "bootstrapDigest",
        "approvalPath",
        "approvalDigest",
        "policyPath",
        "policyDigest",
        "profilePath",
        "profileDigest",
        "packages",
        "networkGrants",
      ],
    );
    if (
      value.schemaVersion !== DESKTOP_NATIVE_PLUGIN_AUTHORITY_SCHEMA ||
      !Array.isArray(value.packages) ||
      value.packages.length > 32 ||
      !Array.isArray(value.networkGrants) ||
      value.networkGrants.length > 32
    )
      invalid();
    const actor = peerActor(value.actor),
      scope = peerScope(value.scope);
    if (
      actor.principalId !== "standalone-principal" ||
      actor.actorId !== "standalone-actor" ||
      actor.tenantId !== "standalone-tenant" ||
      actor.spaceId !== "standalone-space" ||
      scope.tenantId !== actor.tenantId ||
      scope.spaceId !== actor.spaceId
    )
      invalid();
    const packages = value.packages.map(identity);
    if (
      new Set(packages.map((pkg) => pkg.packageDigest)).size !==
        packages.length ||
      new Set(packages.map((pkg) => `${pkg.pluginId}@${pkg.version}`)).size !==
        packages.length
    )
      invalid();
    const networkGrants = value.networkGrants.map(
      (raw): DesktopNativePluginNetworkGrant => {
        const grant = pluginControlRecord(raw, [
          "pluginId",
          "publisherId",
          "version",
          "packageDigest",
          "baseUrl",
          "baseUrlParameter",
          "paths",
        ]);
        const pkg = identity(
          Object.fromEntries(
            ["pluginId", "publisherId", "version", "packageDigest"].map(
              (key) => [key, grant[key]],
            ),
          ),
        );
        if (
          !packages.some(
            (approved) => JSON.stringify(approved) === JSON.stringify(pkg),
          ) ||
          typeof grant.baseUrl !== "string" ||
          grant.baseUrl.length > 2048 ||
          /[\s\p{Cc}\p{Cf}]/u.test(grant.baseUrl) ||
          typeof grant.baseUrlParameter !== "string" ||
          !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(grant.baseUrlParameter) ||
          !Array.isArray(grant.paths) ||
          grant.paths.length < 1 ||
          grant.paths.length > 32
        )
          invalid();
        const url = new URL(grant.baseUrl);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/" ||
          url.href !== grant.baseUrl
        )
          invalid();
        const paths = grant.paths.map(networkPath);
        if (
          new Set(paths.map((rule) => JSON.stringify(rule))).size !==
          paths.length
        )
          invalid();
        return Object.freeze({
          ...pkg,
          baseUrl: grant.baseUrl,
          baseUrlParameter: grant.baseUrlParameter,
          paths: Object.freeze(paths),
        });
      },
    );
    if (
      new Set(
        networkGrants.map(
          (grant) => `${grant.packageDigest}:${grant.baseUrlParameter}`,
        ),
      ).size !== networkGrants.length
    )
      invalid();
    return Object.freeze({
      schemaVersion: DESKTOP_NATIVE_PLUGIN_AUTHORITY_SCHEMA,
      authorityId: peerOpaque(value.authorityId),
      actor,
      scope,
      installRoot: path(value.installRoot),
      controlDatabasePath: path(value.controlDatabasePath),
      bootstrapPath: path(value.bootstrapPath),
      bootstrapDigest: peerDigest(value.bootstrapDigest),
      approvalPath: path(value.approvalPath),
      approvalDigest: peerDigest(value.approvalDigest),
      policyPath: path(value.policyPath),
      policyDigest: peerDigest(value.policyDigest),
      profilePath: path(value.profilePath),
      profileDigest: peerDigest(value.profileDigest),
      packages: Object.freeze(packages),
      networkGrants: Object.freeze(networkGrants),
    });
  } catch {
    return invalid();
  }
}
