import { createHash, hkdfSync } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { loadArtifactEncryptionKey } from "@crewon/artifacts";
import {
  extensionCanonicalJson,
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import type { ProjectMediaMaterialRuntimeInput } from "./project-media-material-runtime.ts";

/** Host environment references only. No secret is serialized into the plugin/bootstrap. */
export type DesktopProjectMaterialStorage = Readonly<{
  artifactRoot: string;
  encryptionKeyPath: string;
  encryptionKeyId: string;
}>;
export function desktopProjectMaterialStorageFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): DesktopProjectMaterialStorage {
  const artifactRoot = environment.CREWON_ARTIFACT_ROOT;
  const encryptionKeyPath = environment.CREWON_ARTIFACT_ENCRYPTION_KEY_PATH;
  const encryptionKeyId = environment.CREWON_ARTIFACT_ENCRYPTION_KEY_ID;
  if (
    !artifactRoot ||
    !isAbsolute(artifactRoot) ||
    !encryptionKeyPath ||
    !isAbsolute(encryptionKeyPath) ||
    !encryptionKeyId ||
    encryptionKeyId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(encryptionKeyId)
  )
    throw new Error("desktop_project_material_storage_required");
  return Object.freeze({ artifactRoot, encryptionKeyPath, encryptionKeyId });
}
/** Domain-separated encryption, stable across Control/Worker and process restarts.
 * The caller clears the returned temporary key after the real archive has copied it.
 */
export function loadDesktopProjectMaterialArchive(
  storage: DesktopProjectMaterialStorage,
  scope: PluginProfileScope,
): ProjectMediaMaterialRuntimeInput["archive"] {
  const captured = desktopProjectMaterialStorageFromEnvironment({
    CREWON_ARTIFACT_ROOT: storage.artifactRoot,
    CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: storage.encryptionKeyPath,
    CREWON_ARTIFACT_ENCRYPTION_KEY_ID: storage.encryptionKeyId,
  });
  const identity = extensionCanonicalJson(parsePluginProfileScope(scope));
  const digest = createHash("sha256").update(identity).digest("hex");
  const master = loadArtifactEncryptionKey(captured.encryptionKeyPath);
  try {
    return Object.freeze({
      archiveId: `native-project-materials-${digest}`,
      rootDirectory: join(
        dirname(captured.artifactRoot),
        `${basename(captured.artifactRoot)}-project-materials`,
        digest,
      ),
      keyId: `${captured.encryptionKeyId}:project-materials-v1`,
      encryptionKey: new Uint8Array(
        hkdfSync(
          "sha256",
          master,
          "crewon.project-material-archive.v1",
          identity,
          32,
        ),
      ),
    });
  } finally {
    master.fill(0);
  }
}
