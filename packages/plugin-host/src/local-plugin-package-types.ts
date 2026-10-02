import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";

/** Host deployment policy, separate from the package's declared sizes. */
export type LocalPluginPackageLimits = Readonly<{
  fileBytes: number;
  totalBytes: number;
  directoryEntries: number;
  directories: number;
}>;

export const DEFAULT_LOCAL_PLUGIN_PACKAGE_LIMITS: LocalPluginPackageLimits =
  Object.freeze({
    fileBytes: 32 * 1024 * 1024,
    totalBytes: 128 * 1024 * 1024,
    directoryEntries: 2048,
    directories: 1024,
  });

export type VerifyLocalPluginPackageInput = Readonly<{
  directory: string;
  limits?: Partial<LocalPluginPackageLimits>;
  signal?: AbortSignal;
}>;

/** A verified snapshot; this is not a continuing attestation of a mutable source directory. */
export type VerifiedLocalPluginPackage = Readonly<{
  directory: string;
  descriptor: PluginPackageDescriptor;
  packageDigest: string;
  totalBytes: number;
  fileCount: number;
}>;

export type PluginPackageInstallationCandidate = Readonly<{
  descriptor: PluginPackageDescriptor;
  packageDigest: string;
}>;

/**
 * Required host policy callback. It must decide installation permission and publisher trust.
 * Publisher metadata is self-declared. Allowing installation does not grant execution rights.
 */
export type PluginPackageInstallationAuthorization = (
  candidate: PluginPackageInstallationCandidate,
) => Promise<Readonly<{ outcome: "allow" }> | Readonly<{ outcome: "deny" }>>;

export type InstallLocalPluginPackageInput = VerifyLocalPluginPackageInput &
  Readonly<{
    /** Existing, private, host-owned directory; never derived from package metadata. */
    installRoot: string;
    authorization: PluginPackageInstallationAuthorization;
  }>;

export type InstalledLocalPluginPackage = VerifiedLocalPluginPackage &
  Readonly<{ outcome: "installed" | "alreadyInstalled" }>;

export class LocalPluginPackageError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "LocalPluginPackageError";
    this.code = code;
  }
}

export function packageFailure(code: string, cause?: unknown): never {
  throw new LocalPluginPackageError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

export function resolvePackageLimits(
  input: Partial<LocalPluginPackageLimits> | undefined,
): LocalPluginPackageLimits {
  const limits = { ...DEFAULT_LOCAL_PLUGIN_PACKAGE_LIMITS, ...input };
  const keys = Object.keys(DEFAULT_LOCAL_PLUGIN_PACKAGE_LIMITS);
  if (
    Object.keys(limits).some((key) => !keys.includes(key)) ||
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    ) ||
    limits.fileBytes > 128 * 1024 * 1024 ||
    limits.totalBytes > 512 * 1024 * 1024 ||
    limits.directoryEntries > 16384 ||
    limits.directories > 8192
  )
    packageFailure("plugin_package_limits_invalid");
  return Object.freeze(limits);
}
