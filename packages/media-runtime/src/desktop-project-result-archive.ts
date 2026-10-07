import { createHash, hkdfSync } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { loadArtifactEncryptionKey } from "@crewon/artifacts";
import {
  extensionCanonicalJson,
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  desktopProjectMaterialStorageFromEnvironment,
  type DesktopProjectMaterialStorage,
} from "./desktop-project-material-archive.ts";
import type { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";

/** Domain-separated encryption, stable across Control/Worker and process restarts.
 * The caller clears the returned temporary key after the real archive has copied it.
 */
export function loadDesktopProjectResultArchive(
  storage: DesktopProjectMaterialStorage,
  scope: PluginProfileScope,
): ConstructorParameters<typeof FilesystemProjectMediaResultArchive>[0] {
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
      archiveId: `native-project-results-${digest}`,
      rootDirectory: join(
        dirname(captured.artifactRoot),
        `${basename(captured.artifactRoot)}-project-results`,
        digest,
      ),
      keyId: `${captured.encryptionKeyId}:project-results-v1`,
      encryptionKey: new Uint8Array(
        hkdfSync(
          "sha256",
          master,
          "crewon.project-result-archive.v1",
          identity,
          32,
        ),
      ),
    });
  } finally {
    master.fill(0);
  }
}
