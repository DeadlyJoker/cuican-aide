import { createHash } from "node:crypto";
import type { ExtensionRegistration } from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionManifest,
  validateExtensionConfiguration,
  type ExtensionConfiguration,
} from "@crewon/domain";
import { readInstalledPluginBusinessManifest } from "./installed-plugin-business-manifest.ts";
import type { PluginActivationCandidate } from "./plugin-node-host.ts";

export type InstalledPluginBusinessRegistration = ExtensionRegistration &
  Readonly<{
    identity: Readonly<{
      pluginId: string;
      publisherId: string;
      version: string;
      packageDigest: string;
    }>;
  }>;
export type InstalledPluginBusinessRegistrationInput = Readonly<{
  installRoot: string;
  expectedPluginId: string;
  expectedPublisherId: string;
  expectedVersion: string;
  expectedPackageDigest: string;
  authorizeRead(
    candidate: PluginActivationCandidate,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
  signal: AbortSignal;
}>;
type Source = Omit<InstalledPluginBusinessRegistrationInput, "signal">;
const sources = new WeakMap<InstalledPluginBusinessRegistration, Source>();
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

/** Reads actual immutable artifacts; never imports plugin code or allocates an external provider. */
export async function loadInstalledPluginBusinessRegistration(
  input: InstalledPluginBusinessRegistrationInput,
): Promise<InstalledPluginBusinessRegistration> {
  if (input === null || typeof input !== "object")
    fail("installed_plugin_business_input_invalid");
  const fields = new Map<string, unknown>();
  for (const name of [
    "installRoot",
    "expectedPluginId",
    "expectedPublisherId",
    "expectedVersion",
    "expectedPackageDigest",
    "authorizeRead",
    "signal",
  ] as const) {
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (field === undefined || !("value" in field) || !field.enumerable)
      fail("installed_plugin_business_input_invalid");
    fields.set(name, field.value);
  }
  const authorizeRead = fields.get("authorizeRead");
  if (typeof authorizeRead !== "function")
    fail("installed_plugin_business_authority_missing");
  const signal = fields.get("signal");
  if (!(signal instanceof AbortSignal))
    fail("installed_plugin_business_input_invalid");
  const source: Source = Object.freeze({
    installRoot: fields.get("installRoot") as string,
    expectedPluginId: fields.get("expectedPluginId") as string,
    expectedPublisherId: fields.get("expectedPublisherId") as string,
    expectedVersion: fields.get("expectedVersion") as string,
    expectedPackageDigest: fields.get("expectedPackageDigest") as string,
    authorizeRead: authorizeRead.bind(input),
  });
  const registration = await readRegistration(source, signal);
  sources.set(registration, source);
  return registration;
}

/** Only a registration read from actual installed bytes can become a deployment input. */
export function assertInstalledPluginBusinessRegistration(
  registration: InstalledPluginBusinessRegistration,
): void {
  if (!sources.has(registration))
    fail("installed_plugin_business_registration_unverified");
}

/** Recheck the exact historical bytes and current host metadata authority before materializing. */
export async function revalidateInstalledPluginBusinessRegistration(
  registration: InstalledPluginBusinessRegistration,
  signal: AbortSignal,
): Promise<void> {
  const source = sources.get(registration);
  if (source === undefined)
    fail("installed_plugin_business_registration_unverified");
  const current = await readRegistration(source, signal);
  if (extensionCanonicalJson(current) !== extensionCanonicalJson(registration))
    fail("installed_plugin_business_registration_changed");
}

/** Shared semantic validation for an installed manifest, with no Comfy-specific parameters. */
export function validateInstalledPluginConfiguration(
  registration: InstalledPluginBusinessRegistration,
  input: unknown,
): ExtensionConfiguration {
  assertInstalledPluginBusinessRegistration(registration);
  const configuration = parseExtensionConfiguration(input, digester);
  if (
    configuration.pluginId !== registration.manifest.pluginId ||
    configuration.pluginVersion !== registration.manifest.version ||
    configuration.manifestDigest !== registration.manifestDigest ||
    configuration.implementationDigest !== registration.implementationDigest
  )
    fail("installed_plugin_business_configuration_mismatch");
  validateExtensionConfiguration(
    registration.manifest,
    configuration.parameters,
  );
  // The execution Host currently has no credential lease service. References alone
  // must not be treated as an executable credential implementation.
  if (configuration.credentialBindings.length !== 0)
    fail("installed_plugin_business_credentials_unavailable");
  return configuration;
}

async function readRegistration(
  source: Source,
  signal: AbortSignal,
): Promise<InstalledPluginBusinessRegistration> {
  if (!(signal instanceof AbortSignal))
    fail("installed_plugin_business_input_invalid");
  signal.throwIfAborted();
  const snapshot = await readInstalledPluginBusinessManifest({
    ...source,
    signal,
  });
  signal.throwIfAborted();
  const descriptor = snapshot.descriptor;
  if (
    descriptor.entrypoints.node === null ||
    !descriptor.requires.some(
      (item) => item.service === "crewon.execution" && item.apiVersion === "1",
    ) ||
    descriptor.requires.some(
      (item) =>
        !item.optional &&
        (item.service !== "crewon.execution" || item.apiVersion !== "1"),
    )
  )
    fail("installed_plugin_business_execution_unavailable");
  const manifest = parseExtensionManifest(snapshot.manifest);
  if (
    manifest.pluginId !== descriptor.pluginId ||
    manifest.version !== descriptor.version
  )
    fail("installed_plugin_business_identity_mismatch");
  return Object.freeze({
    manifest,
    manifestDigest: digester.sha256(extensionCanonicalJson(manifest)),
    // A new, explicit recipe binds the entire installed implementation closure.
    // Existing bundled v0 implementation digests are never reinterpreted.
    implementationDigest: digester.sha256(
      extensionCanonicalJson({
        schemaVersion: "crewon.installed-plugin-implementation.v1",
        packageDigest: snapshot.packageDigest,
        node: descriptor.entrypoints.node,
      }),
    ),
    identity: Object.freeze({
      pluginId: descriptor.pluginId,
      publisherId: descriptor.publisherId,
      version: descriptor.version,
      packageDigest: snapshot.packageDigest,
    }),
  });
}

function fail(code: string): never {
  throw new Error(code);
}
