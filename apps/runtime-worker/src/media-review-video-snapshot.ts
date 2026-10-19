import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  copyMaterialByteChunk,
  materialByteLength,
} from "@crewon/media-runtime/material-byte-snapshot";

export class MediaVideoSnapshot {
  readonly #directory: string;
  readonly #path: string;
  readonly #device: number;
  readonly #inode: number;
  readonly #fileDevice: number;
  readonly #fileInode: number;
  readonly #size: number;
  private constructor(input: {
    directory: string;
    device: number;
    inode: number;
    fileDevice: number;
    fileInode: number;
    size: number;
  }) {
    this.#directory = input.directory;
    this.#path = join(input.directory, "source.mp4");
    this.#device = input.device;
    this.#inode = input.inode;
    this.#fileDevice = input.fileDevice;
    this.#fileInode = input.fileInode;
    this.#size = input.size;
  }
  static async create(
    input: Readonly<{
      bytes: Uint8Array;
      expectedDigest: string;
      tempRoot: string;
      maxBytes: number;
      signal: AbortSignal;
    }>,
  ): Promise<MediaVideoSnapshot> {
    const length = materialByteLength(input.bytes);
    if (
      length < 16 ||
      length > input.maxBytes ||
      !/^sha256:[a-f0-9]{64}$/u.test(input.expectedDigest)
    )
      throw new Error("input_invalid");
    const header = copyMaterialByteChunk(input.bytes, 0, 12);
    if (
      header.toString("latin1", 4, 8) !== "ftyp" ||
      header.readUInt32BE(0) < 16 ||
      header.readUInt32BE(0) > Math.min(length, 64 * 1024) ||
      !/^(?:isom|iso[2-9]|mp4[12]|avc1|dash|cmf[cs]|MSNV|M4V |M4VH|M4VP)$/u.test(
        header.toString("latin1", 8, 12),
      )
    )
      throw new Error("input_invalid");
    // A private canonical root is host configuration, never supplied by a model/tool argument.
    if ((await realpath(input.tempRoot)) !== input.tempRoot)
      throw new Error("configuration_invalid");
    const root = await lstat(input.tempRoot);
    if (
      !root.isDirectory() ||
      (root.mode & 0o077) !== 0 ||
      (process.getuid && root.uid !== process.getuid())
    )
      throw new Error("configuration_invalid");
    input.signal.throwIfAborted();
    const directory = await mkdtemp(join(input.tempRoot, "video-review-"));
    await chmod(directory, 0o700);
    const identity = await lstat(directory);
    let file: FileHandle | null = null;
    try {
      file = await open(
        join(directory, "source.mp4"),
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      const hash = createHash("sha256");
      for (let start = 0; start < length; start += 64 * 1024) {
        input.signal.throwIfAborted();
        const chunk = copyMaterialByteChunk(
          input.bytes,
          start,
          Math.min(64 * 1024, length - start),
        );
        hash.update(chunk);
        let written = 0;
        while (written < chunk.length) {
          const result = await file.write(
            chunk,
            written,
            chunk.length - written,
            start + written,
          );
          if (result.bytesWritten === 0) throw new Error("snapshot_failed");
          written += result.bytesWritten;
        }
      }
      if (`sha256:${hash.digest("hex")}` !== input.expectedDigest)
        throw new Error("input_digest_mismatch");
      await file.chmod(0o400);
      await file.sync();
      const stat = await file.stat();
      return new MediaVideoSnapshot({
        directory,
        device: identity.dev,
        inode: identity.ino,
        fileDevice: stat.dev,
        fileInode: stat.ino,
        size: length,
      });
    } catch (error) {
      await file?.close();
      file = null;
      await removeOwnedDirectory(directory, identity.dev, identity.ino);
      throw error;
    } finally {
      await file?.close();
    }
  }
  get directory(): string {
    return this.#directory;
  }
  async openDescriptor(): Promise<FileHandle> {
    const file = await open(
      this.#path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const s = await file.stat();
    if (
      !s.isFile() ||
      s.size !== this.#size ||
      s.dev !== this.#fileDevice ||
      s.ino !== this.#fileInode
    ) {
      await file.close();
      throw new Error("snapshot_changed");
    }
    return file;
  }
  async close(): Promise<void> {
    await removeOwnedDirectory(this.#directory, this.#device, this.#inode);
  }
}
async function removeOwnedDirectory(
  path: string,
  device: number,
  inode: number,
): Promise<void> {
  const current = await lstat(path);
  if (!current.isDirectory() || current.dev !== device || current.ino !== inode)
    throw new Error("snapshot_changed");
  await rm(path, { recursive: true });
}
