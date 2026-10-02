import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { PluginInstallationStore } from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionManifest,
  parseInstalledPluginPackage,
  type PluginTaskAdmission,
  type InstalledPluginPackage,
  type PluginProfileScope,
} from "@crewon/domain";
import type { PluginActivationCandidate } from "@crewon/plugin-host";
import type { RuntimeExtensionMaterialization } from "../extensions/extension-runtime-proof.ts";
import { InstalledPluginRuntimeError } from "./installed-plugin-run-runtime.ts";

export function fail(code: string): never {
  throw new InstalledPluginRuntimeError(code);
}

export async function readPackage(
  installations: PluginInstallationStore,
  admission: PluginTaskAdmission,
  scope: PluginProfileScope,
  signal: AbortSignal,
): Promise<InstalledPluginPackage> {
  signal.throwIfAborted();
  const raw = await installations.loadPackage({
    scope,
    packageDigest: admission.packageDigest,
  });
  signal.throwIfAborted();
  if (raw === null) fail("installed_plugin_package_missing");
  const pkg = parseInstalledPluginPackage(raw);
  for (const field of [
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ] as const)
    if (pkg[field] !== admission[field])
      fail("installed_plugin_package_mismatch");
  return pkg;
}

/** Called only with the host's verified descriptor and its host-owned install root. */
export async function assertPackageCandidate(input: {
  candidate: PluginActivationCandidate;
  package: InstalledPluginPackage;
  proof: RuntimeExtensionMaterialization;
  installRoot: string;
  signal: AbortSignal;
}): Promise<void> {
  const { candidate, proof } = input;
  input.signal.throwIfAborted();
  for (const field of ["pluginId", "publisherId", "version"] as const)
    if (candidate.descriptor[field] !== input.package[field])
      fail("installed_plugin_descriptor_mismatch");
  if (candidate.packageDigest !== input.package.packageDigest)
    fail("installed_plugin_descriptor_mismatch");
  const path = candidate.descriptor.businessManifestPath;
  if (path === null) fail("installed_plugin_business_manifest_missing");
  const file = candidate.descriptor.files.find((item) => item.path === path);
  if (file === undefined || file.byteLength > 128 * 1024)
    fail("installed_plugin_business_manifest_invalid");
  const handle = await open(
    join(input.installRoot, "packages", candidate.packageDigest.slice(7), path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.byteLength)
      fail("installed_plugin_business_manifest_invalid");
    const bytes = await handle.readFile();
    input.signal.throwIfAborted();
    if (
      bytes.byteLength !== file.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      fail("installed_plugin_business_manifest_invalid");
    let manifest;
    try {
      manifest = parseExtensionManifest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch (cause) {
      throw new InstalledPluginRuntimeError(
        "installed_plugin_business_manifest_invalid",
        { cause },
      );
    }
    const canonical = extensionCanonicalJson(manifest);
    if (
      canonical !== extensionCanonicalJson(proof.registration.manifest) ||
      `sha256:${createHash("sha256").update(canonical).digest("hex")}` !==
        proof.registration.manifestDigest
    )
      fail("installed_plugin_business_manifest_mismatch");
  } finally {
    await handle.close();
  }
}

/** Cleanup capture must neither execute method getters nor erase a runtime that cannot safely end. */
export function cleanupMethods(input: unknown): Readonly<{
  close?: () => Promise<void>;
  canRetire?: () => boolean;
}> {
  if (input === null || typeof input !== "object") return Object.freeze({});
  const result: { close?: () => Promise<void>; canRetire?: () => boolean } = {};
  for (const name of ["close", "canRetire"] as const) {
    let current: object | null = input;
    for (let depth = 0; current !== null && depth < 8; depth++) {
      const field = Object.getOwnPropertyDescriptor(current, name);
      if (field !== undefined) {
        if ("value" in field && typeof field.value === "function")
          result[name] = field.value.bind(input);
        break;
      }
      current = Object.getPrototypeOf(current);
    }
  }
  return Object.freeze(result);
}
