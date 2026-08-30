import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { ArtifactStoreError } from "@crewon/application";

/** Loads an exact 256-bit key from a private raw or canonical base64 file. */
export function loadArtifactEncryptionKey(filePath: string): Uint8Array {
  if (!path.isAbsolute(filePath)) {
    throw new ArtifactStoreError("artifact_key_path_invalid");
  }
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size < 32 || stat.size > 256) {
    throw new ArtifactStoreError("artifact_key_file_invalid");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ArtifactStoreError("artifact_key_file_permissions_invalid");
  }
  const encoded = readFileSync(filePath);
  if (encoded.byteLength === 32) {
    return new Uint8Array(encoded);
  }
  const base64 = encoded.toString("utf8").trim();
  const decoded = Buffer.from(base64, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== base64) {
    throw new ArtifactStoreError("artifact_key_file_invalid");
  }
  return new Uint8Array(decoded);
}
