import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getComfyImplementationDigest,
  retainExtensionBuild,
  type RetainedExtensionBuild,
} from "@crewon/agent-version/extension-build";

const ARCHIVE_ROOT = "CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT";

/** Native supplies the installed release entry and data root, never a plugin or HTTP caller. */
export async function retainInstalledExtensionBuild(input: {
  environment: Readonly<Record<string, string | undefined>>;
  entrypointUrl: string;
}): Promise<RetainedExtensionBuild | undefined> {
  const dataRoot = input.environment[ARCHIVE_ROOT];
  const enabled = input.environment.CREWON_EXTENSIONS_ENABLED;
  const securityMode = input.environment.CREWON_CONTROL_SECURITY_MODE;
  const entrypointUrl = input.entrypointUrl;
  if (dataRoot === undefined) return undefined;
  if (
    enabled !== "1" ||
    (securityMode !== undefined && securityMode !== "standalone") ||
    typeof dataRoot !== "string" ||
    !isAbsolute(dataRoot) ||
    dataRoot.trim() !== dataRoot ||
    /[\u0000-\u001f\u007f]/u.test(dataRoot) ||
    Buffer.byteLength(dataRoot, "utf8") > 4096
  )
    throw new Error("extension_installed_build_archive_configuration_invalid");
  let entry: string;
  try {
    const url = new URL(entrypointUrl);
    if (url.protocol !== "file:" || url.search || url.hash) throw new Error();
    entry = fileURLToPath(url);
  } catch {
    throw new Error("extension_installed_build_archive_entry_invalid");
  }
  if (entrypointUrl !== import.meta.url)
    throw new Error("extension_installed_build_archive_entry_invalid");
  if (
    !entry.endsWith("/runtime-release.mjs") &&
    !entry.endsWith("\\runtime-release.mjs")
  )
    throw new Error("extension_installed_build_archive_entry_invalid");
  // This accessor verifies the running bundle's injected identity and loaded bytes.
  // Reading a sidecar alone would not prove which implementation is executing.
  const expectedImplementationDigest = getComfyImplementationDigest();
  return await retainExtensionBuild({
    dataRoot,
    currentBuildDirectory: dirname(entry),
    expectedImplementationDigest,
  });
}
