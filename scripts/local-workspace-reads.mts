import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";

export const WORKSPACE_FILE_PREFIX_BYTES = 24 * 1024;
const DIRECTORY_ENTRY_LIMIT = 200;
const DIRECTORY_SCAN_LIMIT = 10_000;
const DIRECTORY_SCAN_MILLISECONDS = 1000;
type Entry = { name: string; kind: "file" | "directory" };

/** The caller supplies its already-resolved workspace path. Never allocate the whole file. */
export async function readWorkspaceFilePrefix(
  path: string,
  options: { signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size))
      throw new Error("workspace_path_invalid");
    const buffer = Buffer.alloc(WORKSPACE_FILE_PREFIX_BYTES + 1);
    let received = 0;
    while (received < buffer.length) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        received,
        buffer.length - received,
        received,
      );
      if (bytesRead === 0) break;
      received += bytesRead;
    }
    options.signal?.throwIfAborted();
    return {
      content: buffer
        .subarray(0, Math.min(received, WORKSPACE_FILE_PREFIX_BYTES))
        .toString("utf8"),
      byteLength: Math.max(metadata.size, received),
      truncated:
        metadata.size > WORKSPACE_FILE_PREFIX_BYTES ||
        received > WORKSPACE_FILE_PREFIX_BYTES,
    };
  } finally {
    await handle.close();
  }
}

/** Preserve the globally sorted first page, with bounded memory and scan work. */
export async function listWorkspaceDirectory(
  path: string,
  options: { signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const deadline = performance.now() + DIRECTORY_SCAN_MILLISECONDS;
  const entries: Entry[] = [];
  let scanned = 0,
    visible = 0;
  for await (const entry of await opendir(path)) {
    options.signal?.throwIfAborted();
    if (++scanned > DIRECTORY_SCAN_LIMIT)
      throw new Error("workspace_directory_scan_limit_exceeded");
    if (performance.now() > deadline)
      throw new Error("workspace_directory_scan_deadline_exceeded");
    if (!entry.isFile() && !entry.isDirectory()) continue;
    visible++;
    const candidate: Entry = {
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : "file",
    };
    let low = 0,
      high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareEntries(entries[middle]!, candidate) < 0) low = middle + 1;
      else high = middle;
    }
    if (low < DIRECTORY_ENTRY_LIMIT) {
      entries.splice(low, 0, candidate);
      if (entries.length > DIRECTORY_ENTRY_LIMIT) entries.pop();
    }
  }
  options.signal?.throwIfAborted();
  return { entries, truncated: visible > DIRECTORY_ENTRY_LIMIT };
}

function compareEntries(left: Entry, right: Entry) {
  return left.kind === right.kind
    ? left.name.localeCompare(right.name)
    : left.kind === "directory"
      ? -1
      : 1;
}
