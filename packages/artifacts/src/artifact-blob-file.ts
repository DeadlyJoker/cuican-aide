import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { ArtifactStoreError } from "@crewon/application";

/** All writers of this staging name hold the artifact database's write transaction. */
export function artifactStagingPath(finalPath: string): string {
  return `${finalPath}.staging-v1`;
}

export function validateArtifactDirectories(
  blobDirectory: string,
  filename: string,
): void {
  for (const directory of [
    path.dirname(blobDirectory),
    blobDirectory,
    path.dirname(path.dirname(filename)),
    path.dirname(filename),
  ]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ArtifactStoreError("artifact_blob_path_invalid");
  }
}

/** Reject oversize, short and non-regular files before allocating their contents. */
export function readBoundedArtifactBlob(
  filename: string,
  expectedBytes: number,
): Buffer {
  const initial = lstatSync(filename);
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size !== expectedBytes
  )
    throw new ArtifactStoreError("artifact_ciphertext_invalid");
  const descriptor = openSync(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size !== expectedBytes ||
      before.ino !== initial.ino ||
      before.dev !== initial.dev
    )
      throw new ArtifactStoreError("artifact_ciphertext_invalid");
    const content = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < content.byteLength) {
      const read = readSync(
        descriptor,
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (read === 0)
        throw new ArtifactStoreError("artifact_ciphertext_invalid");
      offset += read;
    }
    if (fstatSync(descriptor).size !== expectedBytes)
      throw new ArtifactStoreError("artifact_ciphertext_invalid");
    return content;
  } finally {
    closeSync(descriptor);
  }
}

/** A validated semantic retry can replace its own partial staging file under the same lock. */
export function stageArtifactBlob(
  finalPath: string,
  content: Uint8Array,
): void {
  const temporaryPath = artifactStagingPath(finalPath);
  const existing = lstatSync(temporaryPath, { throwIfNoEntry: false });
  if (
    existing &&
    (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
  )
    throw new ArtifactStoreError("artifact_ciphertext_invalid");
  const descriptor = openSync(
    temporaryPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1)
      throw new ArtifactStoreError("artifact_ciphertext_invalid");
    // The encrypted length is immutable for this metadata row. Write at explicit offsets;
    // a corrupt longer staging file is rejected by recovery and replaced by the caller below.
    let offset = 0;
    while (offset < content.byteLength) {
      const written = writeSync(
        descriptor,
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (written === 0) throw new ArtifactStoreError("artifact_write_stalled");
      offset += written;
    }
    // Truncation is part of replacing the known, immutable payload, never orphan cleanup.
    ftruncateSync(descriptor, content.byteLength);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  promoteArtifactBlob(finalPath);
}

export function promoteArtifactBlob(finalPath: string): void {
  renameSync(artifactStagingPath(finalPath), finalPath);
  const directory = openSync(path.dirname(finalPath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Only after the final ciphertext is authenticated, while the artifact write lock is held. */
export function discardArtifactStaging(finalPath: string): void {
  const temporaryPath = artifactStagingPath(finalPath);
  const info = lstatSync(temporaryPath, { throwIfNoEntry: false });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new ArtifactStoreError("artifact_ciphertext_invalid");
  unlinkSync(temporaryPath);
}
