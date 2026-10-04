import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { lstatSync } from "node:fs";
import { inspect } from "node:util";
import {
  parseInstalledPluginPeerRequest,
  parsePluginUiJsonValue,
  type DesktopNativePluginAuthority,
  type InstalledPluginPeerIdentity,
} from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import {
  captureNativeAuthorityFile,
  captureNativePluginAuthority,
} from "./desktop-native-plugin-authority-files.ts";
import {
  desktopPluginPrivatePath,
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export const DESKTOP_NATIVE_PLUGIN_CONTROL_CONFIG_ENV =
  "CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH";
export const DESKTOP_NATIVE_PLUGIN_AUTHORITY_ENV =
  "CREWON_DESKTOP_NATIVE_PLUGIN_AUTHORITY_PATH";
export type DesktopNativePluginControlConfig = Readonly<{
  authority: DesktopNativePluginAuthority;
  publication: Readonly<{
    actor: DesktopNativePluginAuthority["actor"];
    scope: DesktopNativePluginAuthority["scope"];
    installRoot: string;
    timeoutMs: number;
    peer: Readonly<{ origin: string; tokenEnvironmentVariable: string }>;
    entries: readonly Readonly<{
      identity: InstalledPluginPeerIdentity;
      configuration: ExtensionConfiguration;
      target: ExtensionExecutionTarget;
    }>[];
  }>;
  peerToken: string;
}>;
const issued = new WeakMap<
  object,
  Readonly<{ assertCurrent(): void; bootstrap: DesktopPluginConfiguration }>
>();
const digester = Object.freeze({
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
});
export function isDesktopNativePluginControlConfig(
  value: unknown,
): value is DesktopNativePluginControlConfig {
  return value !== null && typeof value === "object" && issued.has(value);
}
export function assertDesktopNativePluginControlConfigCurrent(
  value: unknown,
): asserts value is DesktopNativePluginControlConfig {
  if (!isDesktopNativePluginControlConfig(value)) invalid();
  issued.get(value)!.assertCurrent();
}
/** Only the original Main's private, byte-pinned file can lend this local execution authority. */
export function loadDesktopNativePluginControlEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  input: Readonly<{
    securityMode: "production" | "standalone";
    desktopBootstrapPath?: string;
    databasePath?: string;
  }>,
): DesktopNativePluginControlConfig | undefined {
  const field = Object.getOwnPropertyDescriptor(
    environment,
    DESKTOP_NATIVE_PLUGIN_CONTROL_CONFIG_ENV,
  );
  if (field === undefined || ("value" in field && field.value === undefined))
    return undefined;
  if (
    !("value" in field) ||
    input.securityMode !== "standalone" ||
    input.desktopBootstrapPath === undefined ||
    input.databasePath === undefined ||
    process.platform === "win32"
  )
    invalid();
  try {
    const path = desktopPluginPrivatePath(field.value),
      file = captureNativeAuthorityFile(path, 128 * 1024);
    const value = pluginSecurityRecord(file.value, [
      "schemaVersion",
      "authorityPath",
      "peer",
      "entries",
    ]);
    if (value.schemaVersion !== "crewon.desktop-native-plugin-control.v1")
      invalid();
    const authorityPath = desktopPluginPrivatePath(value.authorityPath),
      authorityField = Object.getOwnPropertyDescriptor(
        environment,
        DESKTOP_NATIVE_PLUGIN_AUTHORITY_ENV,
      );
    if (
      authorityField === undefined ||
      !("value" in authorityField) ||
      authorityField.value !== authorityPath
    )
      invalid();
    const captured = captureNativePluginAuthority(authorityPath),
      authority = captured.authority;
    const dataDirectory = dirname(authority.controlDatabasePath);
    if (
      authority.bootstrapPath !== input.desktopBootstrapPath ||
      authority.controlDatabasePath !== input.databasePath ||
      basename(authorityPath) !== "authority.json" ||
      basename(path) !== "native-control.json" ||
      dirname(dirname(authorityPath)) !== dataDirectory ||
      dirname(dirname(path)) !== dataDirectory ||
      !/^\.native-plugin-authority-[a-zA-Z0-9_-]+$/u.test(
        basename(dirname(authorityPath)),
      ) ||
      !/^\.installed-plugin-preparation-[a-zA-Z0-9_-]+$/u.test(
        basename(dirname(path)),
      )
    )
      invalid();
    for (const directory of [dirname(path), dirname(authorityPath)]) {
      const metadata = lstatSync(directory);
      if (
        metadata.uid !== process.getuid?.() ||
        (metadata.mode & 0o777) !== 0o700
      )
        invalid();
    }
    const peer = pluginSecurityRecord(value.peer, [
      "origin",
      "tokenEnvironmentVariable",
    ]);
    if (
      peer.tokenEnvironmentVariable !==
        "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN" ||
      typeof peer.origin !== "string"
    )
      invalid();
    const origin = new URL(peer.origin);
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      !origin.port ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.origin !== peer.origin
    )
      invalid();
    const tokenField = Object.getOwnPropertyDescriptor(
      environment,
      peer.tokenEnvironmentVariable,
    );
    const token =
      tokenField !== undefined && "value" in tokenField
        ? tokenField.value
        : undefined;
    if (
      typeof token !== "string" ||
      token.length < 32 ||
      token.length > 8192 ||
      !/^[\x21-\x7e]+$/u.test(token)
    )
      invalid();
    if (
      !Array.isArray(value.entries) ||
      value.entries.length < 1 ||
      value.entries.length > 32
    )
      invalid();
    const entries = value.entries.map((raw) => {
      const entry = pluginSecurityRecord(raw, [
        "identity",
        "configuration",
        "configuredTarget",
      ]);
      const request = parseInstalledPluginPeerRequest({
        protocol: "crewon.installed-plugin-peer-request.v1",
        requestId: "native-control-prepare",
        operation: "prepareCandidate",
        actor: authority.actor,
        scope: authority.scope,
        identity: entry.identity,
        configuration: entry.configuration,
        expectedTarget: entry.configuredTarget,
        expectedSelectionRevision: 1,
      });
      if (request.operation !== "prepareCandidate") invalid();
      const configuration = parseExtensionConfiguration(
          parsePluginUiJsonValue(request.configuration),
          digester,
        ),
        target = parseExtensionExecutionTarget(request.expectedTarget),
        identity = request.identity;
      if (
        configuration.tenantId !== authority.scope.tenantId ||
        configuration.spaceId !== authority.scope.spaceId ||
        configuration.pluginId !== identity.pluginId ||
        configuration.pluginVersion !== identity.version ||
        configuration.manifestDigest !== identity.manifestDigest ||
        configuration.implementationDigest !== identity.implementationDigest ||
        !authority.packages.some((pkg) =>
          Object.entries(pkg).every(
            ([key, expected]) =>
              identity[key as keyof typeof identity] === expected,
          ),
        )
      )
        invalid();
      return Object.freeze({
        identity: Object.freeze({ ...identity }),
        configuration,
        target: Object.freeze({ ...target }),
      });
    });
    if (
      new Set(entries.map((entry) => entry.identity.pluginId)).size !==
      entries.length
    )
      invalid();
    const publication = Object.freeze({
      actor: authority.actor,
      scope: authority.scope,
      installRoot: authority.installRoot,
      timeoutMs: 25000,
      peer: Object.freeze({
        origin: peer.origin,
        tokenEnvironmentVariable: peer.tokenEnvironmentVariable,
      }),
      entries: Object.freeze(entries),
    });
    const result = { authority, publication, peerToken: token };
    Object.defineProperties(result, {
      toJSON: {
        value: () => ({ authority, publication, peerToken: "[REDACTED]" }),
      },
      [inspect.custom]: {
        value: () => ({ authority, publication, peerToken: "[REDACTED]" }),
      },
    });
    Object.freeze(result);
    const bootstrap = captureNativeAuthorityFile(
      authority.bootstrapPath,
      128 * 1024,
    );
    const configuration = parseDesktopPluginConfiguration(bootstrap.value);
    issued.set(result, {
      bootstrap: configuration,
      assertCurrent: () => {
        file.assertCurrent();
        captured.assertCurrent();
        bootstrap.assertCurrent();
      },
    });
    assertDesktopNativePluginControlConfigCurrent(result);
    return result;
  } catch {
    invalid();
  }
}
export function assertDesktopNativePluginControlComposition(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    nativeControl: DesktopNativePluginControlConfig;
  }>,
): void {
  assertDesktopNativePluginControlConfigCurrent(input.nativeControl);
  const configuration = parseDesktopPluginConfiguration(input.configuration),
    authority = input.nativeControl.authority;
  if (
    extensionCanonicalJson(configuration) !==
      extensionCanonicalJson(issued.get(input.nativeControl)!.bootstrap) ||
    extensionCanonicalJson(configuration.actor) !==
      extensionCanonicalJson(authority.actor) ||
    extensionCanonicalJson(configuration.scope) !==
      extensionCanonicalJson(authority.scope) ||
    configuration.installRoot !== authority.installRoot ||
    authority.packages.some(
      (pkg) =>
        !configuration.sources.some((source) =>
          Object.entries(pkg).every(
            ([key, value]) => source[key as keyof typeof source] === value,
          ),
        ),
    )
  )
    invalid();
}
function invalid(): never {
  throw new Error("desktop_native_plugin_control_configuration_invalid");
}
