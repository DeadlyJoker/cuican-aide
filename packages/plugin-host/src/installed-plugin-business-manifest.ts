import { join } from "node:path";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import type { PluginActivationCandidate } from "./plugin-node-host.ts";
import {
  assertDirectoryPins,
  hostPath,
  pinDirectory,
  readPackageFile,
  type DirectoryPin,
} from "./local-plugin-package-files.ts";
import { packageFailure } from "./local-plugin-package-types.ts";
import {
  sha256,
  verifyLocalPluginPackage,
} from "./local-plugin-package-verifier.ts";

export type ReadInstalledPluginBusinessManifestInput = Readonly<{
  installRoot: string;
  expectedPluginId: string;
  expectedPublisherId: string;
  expectedVersion: string;
  expectedPackageDigest: string;
  signal: AbortSignal;
  /** Read permission only; this never grants Node activation or Run execution. */
  authorizeRead(
    candidate: PluginActivationCandidate,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
}>;

export type InstalledPluginBusinessManifest = Readonly<{
  descriptor: PluginPackageDescriptor;
  packageDigest: string;
  /** Detached JSON; the business schema belongs to the consuming subsystem. */
  manifest: unknown;
}>;

const MAXIMUM_MANIFEST_BYTES = 128 * 1024;

/** Reads verified installed JSON without importing any Node or UI module. */
export async function readInstalledPluginBusinessManifest(
  input: ReadInstalledPluginBusinessManifestInput,
): Promise<InstalledPluginBusinessManifest> {
  const captured = captureInput(input);
  captured.signal.throwIfAborted();
  const before = await verifyInstalled(captured);
  const manifestPath = before.descriptor.businessManifestPath;
  if (manifestPath === null) packageFailure("plugin_business_manifest_missing");
  const declared = before.descriptor.files.find(
    (file) => file.path === manifestPath,
  );
  if (declared === undefined)
    packageFailure("plugin_business_manifest_missing");
  if (declared.byteLength > MAXIMUM_MANIFEST_BYTES)
    packageFailure("plugin_business_manifest_limit");
  const parents: DirectoryPin[] = [before.packagePin];
  const parts = manifestPath.split("/");
  for (let index = 1; index < parts.length; index++) {
    const directory = join(before.directory, ...parts.slice(0, index));
    const pin = await pinDirectory(directory);
    if (pin.path !== directory)
      packageFailure("plugin_package_directory_invalid");
    parents.push(pin);
  }
  const bytes = await readPackageFile({
    path: join(before.directory, manifestPath),
    maximumBytes: MAXIMUM_MANIFEST_BYTES,
    expectedBytes: declared.byteLength,
    parents,
    signal: captured.signal,
  });
  if (sha256(bytes) !== declared.sha256)
    packageFailure("plugin_business_manifest_digest_mismatch");
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    packageFailure("plugin_business_manifest_invalid", error);
  }
  captured.signal.throwIfAborted();
  const candidate = Object.freeze({
    descriptor: before.descriptor,
    packageDigest: captured.expectedPackageDigest,
  });
  const decision = await captured.authorizeRead(candidate, captured.signal);
  captured.signal.throwIfAborted();
  if (decision !== "allow")
    packageFailure("plugin_business_manifest_read_denied");
  await verifyInstalled(captured);
  await assertDirectoryPins(before.boundaryPins, false);
  await assertDirectoryPins(parents);
  captured.signal.throwIfAborted();
  return Object.freeze({
    descriptor: before.descriptor,
    packageDigest: captured.expectedPackageDigest,
    manifest,
  });
}

function captureInput(
  input: ReadInstalledPluginBusinessManifestInput,
): ReadInstalledPluginBusinessManifestInput {
  if (input === null || typeof input !== "object")
    packageFailure("plugin_business_manifest_input_invalid");
  const value = (name: keyof ReadInstalledPluginBusinessManifestInput) => {
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (field === undefined || !("value" in field) || !field.enumerable)
      packageFailure("plugin_business_manifest_input_invalid");
    return field.value as unknown;
  };
  const installRoot = hostPath(value("installRoot") as string);
  const expectedPluginId = value("expectedPluginId");
  const expectedPublisherId = value("expectedPublisherId");
  const expectedVersion = value("expectedVersion");
  const expectedPackageDigest = value("expectedPackageDigest");
  const signal = value("signal");
  const authorizeRead = value("authorizeRead");
  if (
    typeof expectedPluginId !== "string" ||
    !/^[a-z][a-z0-9._-]{0,127}$/u.test(expectedPluginId) ||
    typeof expectedPublisherId !== "string" ||
    !/^[a-z][a-z0-9._-]{0,127}$/u.test(expectedPublisherId) ||
    typeof expectedVersion !== "string" ||
    !/^[0-9A-Za-z.+-]{1,128}$/u.test(expectedVersion) ||
    typeof expectedPackageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(expectedPackageDigest) ||
    !(signal instanceof AbortSignal) ||
    typeof authorizeRead !== "function"
  )
    packageFailure("plugin_business_manifest_input_invalid");
  return Object.freeze({
    installRoot,
    expectedPluginId,
    expectedPublisherId,
    expectedVersion,
    expectedPackageDigest,
    signal,
    authorizeRead: authorizeRead.bind(input),
  });
}

async function verifyInstalled(
  input: ReadInstalledPluginBusinessManifestInput,
) {
  input.signal.throwIfAborted();
  const root = await pinDirectory(input.installRoot);
  privateDirectory(root);
  const packagesPath = join(root.path, "packages");
  const packages = await pinDirectory(packagesPath);
  privateDirectory(packages);
  if (packages.path !== packagesPath)
    packageFailure("plugin_package_directory_invalid");
  const directory = join(packagesPath, input.expectedPackageDigest.slice(7));
  const packagePin = await pinDirectory(directory);
  const verified = await verifyLocalPluginPackage({
    directory,
    signal: input.signal,
  });
  const descriptor = verified.descriptor;
  if (
    packagePin.path !== directory ||
    verified.directory !== directory ||
    verified.packageDigest !== input.expectedPackageDigest ||
    descriptor.pluginId !== input.expectedPluginId ||
    descriptor.publisherId !== input.expectedPublisherId ||
    descriptor.version !== input.expectedVersion
  )
    packageFailure("plugin_business_manifest_identity_mismatch");
  const boundaryPins = Object.freeze([root, packages, packagePin]);
  await assertDirectoryPins(boundaryPins, false);
  input.signal.throwIfAborted();
  return { directory, packagePin, boundaryPins, descriptor };
}

function privateDirectory(pin: DirectoryPin): void {
  if (
    (typeof process.getuid === "function" &&
      pin.stats.uid !== BigInt(process.getuid())) ||
    (pin.stats.mode & 0o022n) !== 0n
  )
    packageFailure("plugin_package_install_root_invalid");
}
