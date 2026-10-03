import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  parseRuntimeBindingConfig,
  type RuntimeBindingConfig,
} from "../runtime-binding-config.ts";

export type InstalledPluginGeneratedBindingsManifest = Readonly<{
  path: string;
  config: RuntimeBindingConfig;
}>;
export type InstalledPluginBindingsManifestArtifact = Readonly<{
  publish(): Promise<void>;
  close(): Promise<void>;
}>;
const MAX_BYTES = 1024 * 1024;
type Identity = Readonly<{
  dev: number;
  ino: number;
  size: number;
  mode: number;
  uid: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
}>;

function fail(): never {
  throw new Error("installed_plugin_release_bindings_manifest_unavailable");
}
function same(left: Identity | null, right: Identity | null): boolean {
  if (left === null || right === null) return left === right;
  return (Object.keys(left) as (keyof Identity)[]).every(
    (key) => left[key] === right[key],
  );
}
async function identity(path: string): Promise<Identity | null> {
  let original;
  try {
    original = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !original.isFile() ||
    original.isSymbolicLink() ||
    original.nlink !== 1 ||
    typeof process.getuid !== "function" ||
    original.uid !== process.getuid() ||
    original.size > MAX_BYTES
  )
    fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      before.dev !== original.dev ||
      before.ino !== original.ino ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > MAX_BYTES
    )
      fail();
    const bytes = new Uint8Array(before.size + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const read = await file.read(
        bytes,
        total,
        bytes.byteLength - total,
        total,
      );
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    const after = await file.stat(),
      current = await lstat(path);
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.nlink !== 1 ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.isSymbolicLink()
    )
      fail();
    return Object.freeze({
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mode: before.mode,
      uid: before.uid,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      digest: createHash("sha256")
        .update(bytes.subarray(0, total))
        .digest("hex"),
    });
  } finally {
    await file.close();
  }
}

/** Stages actual parsed bytes; no existing source changes until a committed activation is reported. */
export async function prepareInstalledPluginBindingsManifest(
  input: InstalledPluginGeneratedBindingsManifest,
): Promise<InstalledPluginBindingsManifestArtifact> {
  if (
    typeof input.path !== "string" ||
    input.path.trim() !== input.path ||
    !input.path ||
    Buffer.byteLength(input.path) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.path)
  )
    fail();
  const bytes = Buffer.from(
    JSON.stringify(parseRuntimeBindingConfig(input.config)),
    "utf8",
  );
  if (bytes.byteLength > MAX_BYTES) fail();
  const expectedDigest = createHash("sha256").update(bytes).digest("hex");
  const requested = resolve(input.path),
    parent = await realpath(dirname(requested));
  const target = join(parent, basename(requested));
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail();
  const prior = await identity(target);
  let stage: string | null = join(
    parent,
    `.crewon-installed-bindings-${randomUUID()}`,
  );
  let stageIdentity: Identity | null = null;
  let ownedStageIdentity: Readonly<{ dev: number; ino: number }> | null = null;
  let published = false,
    closed = false;
  let publishing: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  const cleanupStage = async () => {
    if (stage === null) return;
    let current;
    try {
      current = await lstat(stage);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        stage = null;
        return;
      }
      throw error;
    }
    if (
      ownedStageIdentity === null ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== ownedStageIdentity.dev ||
      current.ino !== ownedStageIdentity.ino
    )
      fail();
    const contents = await identity(stage);
    // An interrupted write cannot prove that partial bytes are still ours; preserve it for operator review.
    if (
      contents?.digest !== expectedDigest ||
      (stageIdentity !== null && !same(stageIdentity, contents))
    )
      fail();
    await rm(stage);
    stage = null;
  };
  try {
    const file = await open(
      stage,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const created = await file.stat();
      ownedStageIdentity = Object.freeze({
        dev: created.dev,
        ino: created.ino,
      });
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const checked = await identity(stage);
    if (
      checked === null ||
      checked.digest !== expectedDigest ||
      (checked.mode & 0o077) !== 0
    )
      fail();
    stageIdentity = checked;
  } catch (error) {
    await cleanupStage().catch(() => {});
    throw error;
  }
  const publish = async () => {
    const currentParent = await lstat(parent);
    if (
      (await realpath(dirname(requested))) !== parent ||
      !currentParent.isDirectory() ||
      currentParent.isSymbolicLink() ||
      currentParent.dev !== parentStat.dev ||
      currentParent.ino !== parentStat.ino ||
      !same(prior, await identity(target)) ||
      !same(stageIdentity, await identity(stage!)) ||
      closed
    )
      fail();
    await rename(stage!, target);
    // The rename is the filesystem commit; later durability failure never deletes the new source.
    stage = null;
    published = true;
    const directory = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  return Object.freeze({
    publish() {
      if (closed)
        return Promise.reject(
          new Error("installed_plugin_release_bindings_manifest_unavailable"),
        );
      if (publishing !== null) return publishing;
      if (published) return Promise.resolve();
      publishing = publish();
      return publishing;
    },
    close() {
      if (closing !== null) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([publishing]);
        await cleanupStage();
      })();
      return closing;
    },
  });
}
