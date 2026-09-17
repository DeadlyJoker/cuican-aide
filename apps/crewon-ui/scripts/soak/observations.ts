import {
  appendFileSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { lstat, opendir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Measure the owned helper externally, including when its event loop cannot report. */
export async function readSoakProcessRss(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error("soak_process_pid_invalid");
  const { stdout } = await promisify(execFile)(
    "/bin/ps",
    ["-o", "rss=", "-p", String(pid)],
    {
      timeout: 1000,
      killSignal: "SIGKILL",
      maxBuffer: 1024,
    },
  );
  if (!/^\s*\d+\s*$/u.test(stdout)) throw new Error("soak_process_rss_invalid");
  const rssBytes = Number(stdout.trim()) * 1024;
  if (!Number.isSafeInteger(rssBytes) || rssBytes <= 0)
    throw new Error("soak_process_rss_invalid");
  return { pid, rssBytes, sampledAt: new Date().toISOString() };
}

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const MAX_SOAK_DISK_BYTES = 8 * 1024 ** 3;
export const MIN_FREE_DISK_BYTES = 5 * 1024 ** 3;

export function assertSoakFreeSpace(root: string) {
  const availableBytes = availableDiskBytes(root);
  if (availableBytes < MIN_FREE_DISK_BYTES)
    throw new Error("soak_free_disk_guard");
  return availableBytes;
}

function availableDiskBytes(root: string) {
  const disk = statfsSync(root);
  return disk.bavail * disk.bsize;
}

/** Scan only owned state. Bound traversal too: a tiny-file explosion must fail closed. */
export async function measureSoakDisk(root: string) {
  const deadline = Date.now() + 2000;
  let files = 0,
    allocatedBytes = 0,
    logicalBytes = 0;
  const categories: Record<string, number> = {};
  const visit = async (directory: string) => {
    for await (const entry of await opendir(directory)) {
      if (++files > 20_000 || Date.now() > deadline)
        throw new Error("soak_disk_scan_budget");
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile()) continue;
      logicalBytes += stat.size;
      allocatedBytes += stat.blocks * 512;
      const category = entry.name.endsWith("-wal")
        ? "wal"
        : entry.name.endsWith(".sqlite")
          ? "sqlite"
          : "other";
      categories[category] = (categories[category] ?? 0) + stat.size;
      if (
        logicalBytes > MAX_SOAK_DISK_BYTES ||
        allocatedBytes > MAX_SOAK_DISK_BYTES
      )
        throw new Error("soak_disk_capacity_guard");
    }
  };
  await visit(root);
  return {
    files,
    logicalBytes,
    allocatedBytes,
    categories,
    availableBytes: availableDiskBytes(root),
    concurrentSnapshot: true,
  };
}

/** Two bounded segments, plus fixed summary counters in status.json. */
export function soakJournal(root: string, name: string) {
  if (!/^[a-z-]+$/.test(name)) throw new Error("soak_journal_name_invalid");
  const filename = join(root, `${name}.jsonl`);
  let bytes = 0,
    rotations = 0;
  writeFileSync(filename, "", { flag: "wx", mode: 0o600 });
  return {
    append(value: unknown) {
      const line = JSON.stringify(value) + "\n";
      const size = Buffer.byteLength(line);
      if (size > 128 * 1024) throw new Error("soak_observation_too_large");
      if (bytes + size > MAX_EVIDENCE_BYTES) {
        renameSync(filename, `${filename}.previous`);
        bytes = 0;
        rotations++;
      }
      appendFileSync(filename, line, { mode: 0o600 });
      bytes += size;
    },
    snapshot: () => ({
      bytes,
      rotations,
      segmentLimitBytes: MAX_EVIDENCE_BYTES,
      retainedSegments: 2,
    }),
  };
}

export async function readSoakRuntimeMetrics(root: string) {
  const directory = join(root, "metrics");
  const names = (await readdir(directory)).filter((name) =>
    /^process-(control|worker|electron)-\d+\.json$/.test(name),
  );
  if (names.length > 16) throw new Error("soak_process_history_guard");
  return names.map((name) => {
    const value = readFileSync(join(directory, name));
    if (value.length > 16 * 1024) throw new Error("soak_metric_size_guard");
    return JSON.parse(value.toString("utf8")) as {
      pid: number;
      role: string;
      sampledAt: string;
      memory: { rss: number; heapUsed: number };
      eventLoopP99Ms: number | null;
    };
  });
}
