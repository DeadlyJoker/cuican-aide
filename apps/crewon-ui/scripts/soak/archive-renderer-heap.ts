import { createReadStream, createWriteStream } from "node:fs";
import { lstat, open, readFile, rename, unlink, link } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { RENDERER_HEAP_SNAPSHOT_BYTES as MAX_BYTES } from "./renderer-heap.ts";

const labels = ["warm", "final"] as const;
type Label = (typeof labels)[number];
type Entry = {
  filename: string;
  gzipFilename: string;
  bytes: number;
  sha256: string;
  gzipBytes: number;
  gzipSha256: string;
  verifiedAt: string;
};
type Index = { schemaVersion: 1; entries: Entry[] };
const indexName = "renderer-heap-archive.json";
async function json(path: string, bytes: number) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > bytes)
    throw new Error("soak_heap_archive_metadata_invalid");
  return JSON.parse(await readFile(path, "utf8"));
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function regular(path: string, max: number) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > max)
    throw new Error("soak_heap_archive_file_invalid");
  return stat;
}
async function digest(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  decode = false,
) {
  await regular(path, MAX_BYTES);
  const hash = createHash("sha256");
  let bytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new Error("soak_heap_archive_byte_limit"));
        return;
      }
      hash.update(chunk);
      callback();
    },
  });
  if (decode)
    await pipeline(createReadStream(path), createGunzip(), sink, { signal });
  else await pipeline(createReadStream(path), sink, { signal });
  return { bytes, sha256: hash.digest("hex") };
}
async function syncDirectory(root: string) {
  const fd = await open(root, "r");
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function writeIndex(root: string, index: Index) {
  const temporary = join(root, `.${indexName}.${randomUUID()}.tmp`);
  const fd = await open(temporary, "wx", 0o600);
  try {
    await fd.writeFile(JSON.stringify(index, null, 2) + "\n");
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    await rename(temporary, join(root, indexName));
    await syncDirectory(root);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
function validEntry(value: Entry, label: Label, bytes: number) {
  return (
    value.filename === `renderer-${label}.heapsnapshot` &&
    value.gzipFilename === `${value.filename}.gz` &&
    value.bytes === bytes &&
    Number.isSafeInteger(value.gzipBytes) &&
    value.gzipBytes > 0 &&
    value.gzipBytes < bytes &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    /^[a-f0-9]{64}$/.test(value.gzipSha256) &&
    typeof value.verifiedAt === "string"
  );
}

/** Archive only a completed, quiescent fixture; preserve exact bytes and a durable restore index. */
export async function archiveRendererHeaps(root: string) {
  root = resolve(root);
  if (process.platform === "win32")
    throw new Error("soak_heap_archive_process_groups_unsupported");
  if (!(await lstat(root)).isDirectory())
    throw new Error("soak_heap_archive_root_invalid");
  const status = await json(join(root, "status.json"), 512 * 1024),
    cleanup = await json(join(root, "cleanup.json"), 4096),
    controller = await json(join(root, "controller.json"), 4096);
  if (
    status.phase !== "durationReached" ||
    cleanup.ownedGroupGone !== true ||
    cleanup.desktopExitCode !== 0 ||
    !Number.isSafeInteger(controller.pid) ||
    controller.pid < 1 ||
    controller.pid > 2147483647
  )
    throw new Error("soak_heap_archive_not_completed");
  const activePath = join(dirname(root), "active.json");
  if (await exists(activePath)) {
    const active = await json(activePath, 4096);
    if (resolve(active.root) === root)
      throw new Error("soak_heap_archive_running");
  }
  try {
    process.kill(-controller.pid, 0);
    throw new Error("soak_heap_archive_running");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const metadata = await json(join(root, "renderer-heap.json"), 16 * 1024);
  if (
    metadata.explicitGc !== true ||
    !Array.isArray(metadata.checkpoints) ||
    metadata.checkpoints.length !== 2
  )
    throw new Error("soak_heap_archive_metadata_invalid");
  const snapshots = labels.map((label) => {
    const checkpoints = metadata.checkpoints.filter(
      (entry: { result?: { label?: unknown } }) =>
        entry?.result?.label === label,
    );
    const snapshot = checkpoints[0]?.result?.snapshot;
    if (
      checkpoints.length !== 1 ||
      snapshot.filename !== `renderer-${label}.heapsnapshot` ||
      !Number.isSafeInteger(snapshot.bytes) ||
      snapshot.bytes < 1 ||
      snapshot.bytes > MAX_BYTES
    )
      throw new Error("soak_heap_archive_metadata_invalid");
    return {
      label,
      filename: snapshot.filename as string,
      bytes: snapshot.bytes as number,
    };
  });
  const indexPath = join(root, indexName);
  const index: Index = (await exists(indexPath))
    ? await json(indexPath, 8192)
    : { schemaVersion: 1, entries: [] };
  if (
    index.schemaVersion !== 1 ||
    !Array.isArray(index.entries) ||
    index.entries.length > 2 ||
    index.entries.some(
      (entry) =>
        !snapshots.some((snapshot) =>
          validEntry(entry, snapshot.label, snapshot.bytes),
        ),
    ) ||
    new Set(index.entries.map((entry) => entry.filename)).size !==
      index.entries.length
  )
    throw new Error("soak_heap_archive_index_invalid");
  const lockPath = join(root, ".renderer-heap-archive.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const signal = AbortSignal.timeout(20_000);
  try {
    for (const snapshot of snapshots) {
      const filename = join(root, snapshot.filename),
        gzipFilename = `${snapshot.filename}.gz`,
        gzipPath = join(root, gzipFilename);
      const stored = index.entries.find(
        (entry) => entry.filename === snapshot.filename,
      );
      const hasSource = await exists(filename);
      if (!hasSource && !stored)
        throw new Error("soak_heap_archive_source_missing");
      const original = hasSource
        ? await digest(filename, snapshot.bytes, signal)
        : { bytes: stored!.bytes, sha256: stored!.sha256 };
      if (
        original.bytes !== snapshot.bytes ||
        (stored && original.sha256 !== stored.sha256)
      )
        throw new Error("soak_heap_archive_source_changed");
      if (!(await exists(gzipPath))) {
        if (!hasSource || stored)
          throw new Error("soak_heap_archive_archive_missing");
        const temporary = join(root, `.${gzipFilename}.${randomUUID()}.tmp`);
        let compressedBytes = 0;
        const bound = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            compressedBytes += chunk.length;
            if (compressedBytes >= original.bytes) {
              callback(new Error("soak_heap_archive_not_smaller"));
              return;
            }
            callback(null, chunk);
          },
        });
        try {
          await pipeline(
            createReadStream(filename),
            createGzip({ level: 6 }),
            bound,
            createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
            { signal },
          );
          const restored = await digest(
            temporary,
            snapshot.bytes,
            signal,
            true,
          );
          if (
            restored.sha256 !== original.sha256 ||
            restored.bytes !== original.bytes
          )
            throw new Error("soak_heap_archive_digest_mismatch");
          const fd = await open(temporary, "r");
          try {
            await fd.sync();
          } finally {
            await fd.close();
          }
          await link(temporary, gzipPath); // Exclusive publication; never replace a pre-existing archive.
          await syncDirectory(root);
        } finally {
          await unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
      const gzip = await digest(gzipPath, MAX_BYTES, signal),
        restored = await digest(gzipPath, snapshot.bytes, signal, true);
      if (
        restored.sha256 !== original.sha256 ||
        restored.bytes !== original.bytes ||
        gzip.bytes >= original.bytes ||
        (stored &&
          (gzip.sha256 !== stored.gzipSha256 ||
            gzip.bytes !== stored.gzipBytes))
      )
        throw new Error("soak_heap_archive_digest_mismatch");
      if (!stored) {
        index.entries.push({
          filename: snapshot.filename,
          gzipFilename,
          bytes: original.bytes,
          sha256: original.sha256,
          gzipBytes: gzip.bytes,
          gzipSha256: gzip.sha256,
          verifiedAt: new Date().toISOString(),
        });
        await writeIndex(root, index);
      }
      if (hasSource) {
        // Recheck before removal. The archived bytes and restore index are already synced.
        const current = await digest(filename, snapshot.bytes, signal);
        if (
          current.sha256 !== original.sha256 ||
          current.bytes !== original.bytes
        )
          throw new Error("soak_heap_archive_source_changed");
        signal.throwIfAborted();
        await unlink(filename);
        await syncDirectory(root);
      }
    }
    const sourceBytes = index.entries.reduce(
        (sum, entry) => sum + entry.bytes,
        0,
      ),
      archiveBytes = index.entries.reduce(
        (sum, entry) => sum + entry.gzipBytes,
        0,
      );
    return {
      root,
      sourceBytes,
      archiveBytes,
      savedBytes: sourceBytes - archiveBytes,
      entries: index.entries,
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
