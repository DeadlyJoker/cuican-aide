import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const VIRTUAL_ROOT = "/workspace";
const MAX_FILE_BYTES = 3_000;
const MAX_DIRECTORY_ENTRIES = 120;
const MAX_PATH_BYTES = 8 * 1024;
const MAX_ACTIVE_READS = 4;
let activeReads = 0;

type WorkspaceSnapshot = Readonly<{ root: string; revision: number }>;
export interface WorkspaceReadAuthority {
  captureRoot(): WorkspaceSnapshot;
  assertRootCurrent(snapshot: WorkspaceSnapshot): void;
}
type DirectoryEntry = Readonly<{
  kind: "directory" | "file" | "symlink";
  name: string;
  path: string;
  size: number;
}>;

// Shared by every native workspace reader in this process. No waiting queue;
// admission is released only when the real I/O and descriptor cleanup settle.
async function admitted<T>(read: () => Promise<T>): Promise<T> {
  if (activeReads >= MAX_ACTIVE_READS)
    throw new Error("desktop_sandbox_read_capacity_exhausted");
  activeReads++;
  try {
    return await read();
  } finally {
    activeReads--;
  }
}

export function readWorkspaceFile(
  authority: WorkspaceReadAuthority,
  requestedPath: string,
) {
  return admitted(async () => {
    const workspace = authority.captureRoot();
    const resolved = await resolvePath(workspace.root, requestedPath, "file");
    authority.assertRootCurrent(workspace);
    const handle = await open(
      resolved.target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let result;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || !sameFile(metadata, resolved.metadata))
        invalid();
      await assertPathCurrent(resolved.target, resolved.metadata);
      authority.assertRootCurrent(workspace);
      const bytes = Buffer.allocUnsafe(MAX_FILE_BYTES);
      let length = 0;
      while (length < bytes.byteLength) {
        const { bytesRead } = await handle.read(
          bytes,
          length,
          bytes.byteLength - length,
          length,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      result = {
        path: resolved.virtualPath,
        content: bytes.subarray(0, length).toString("utf8"),
        byteLength: metadata.size,
        truncated: metadata.size > length,
      };
    } finally {
      await handle.close();
    }
    authority.assertRootCurrent(workspace);
    return result;
  });
}

export function listWorkspaceDirectory(
  authority: WorkspaceReadAuthority,
  requestedPath = VIRTUAL_ROOT,
) {
  return admitted(async () => {
    const workspace = authority.captureRoot();
    const resolved = await resolvePath(
      workspace.root,
      requestedPath,
      "directory",
    );
    authority.assertRootCurrent(workspace);
    const directory = await opendir(resolved.target, { bufferSize: 32 });
    const entries: DirectoryEntry[] = [];
    let truncated = false;
    try {
      await assertPathCurrent(resolved.target, resolved.metadata);
      // Enumerate at most 120 names plus one lookahead. Sorting applies only to
      // the returned partial view, never materializes the entire directory.
      for (let scanned = 0; scanned <= MAX_DIRECTORY_ENTRIES; scanned++) {
        authority.assertRootCurrent(workspace);
        const entry = await directory.read();
        if (entry === null) break;
        if (scanned === MAX_DIRECTORY_ENTRIES) {
          truncated = true;
          break;
        }
        const filename = join(resolved.target, entry.name);
        let metadata: Stats;
        try {
          metadata = await lstat(filename);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            continue;
          throw error;
        }
        const kind = metadata.isSymbolicLink()
          ? "symlink"
          : metadata.isDirectory()
            ? "directory"
            : metadata.isFile()
              ? "file"
              : null;
        if (kind !== null)
          entries.push({
            kind,
            name: entry.name,
            path: virtualPath(workspace.root, filename),
            size: metadata.size,
          });
      }
      await assertPathCurrent(resolved.target, resolved.metadata);
    } finally {
      await directory.close();
    }
    authority.assertRootCurrent(workspace);
    entries.sort((left, right) =>
      left.kind === right.kind
        ? left.name.localeCompare(right.name)
        : left.kind === "directory"
          ? -1
          : right.kind === "directory"
            ? 1
            : left.name.localeCompare(right.name),
    );
    return {
      root: VIRTUAL_ROOT,
      path: resolved.virtualPath,
      entries,
      truncated,
    };
  });
}

async function resolvePath(
  root: string,
  requestedPath: string,
  expected: "file" | "directory",
) {
  if (
    typeof requestedPath !== "string" ||
    Buffer.byteLength(requestedPath) > MAX_PATH_BYTES ||
    (requestedPath !== VIRTUAL_ROOT &&
      !requestedPath.startsWith(`${VIRTUAL_ROOT}/`))
  )
    invalid();
  const segments = requestedPath
    .slice(VIRTUAL_ROOT.length)
    .split("/")
    .filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || segment.includes("\0"),
    )
  )
    invalid();
  const target = await realpath(resolve(root, ...segments));
  if (target !== root && !target.startsWith(`${root}${sep}`)) invalid();
  const metadata = await lstat(target);
  if (
    metadata.isSymbolicLink() ||
    (expected === "file" ? !metadata.isFile() : !metadata.isDirectory())
  )
    invalid();
  return { target, metadata, virtualPath: virtualPath(root, target) };
}
async function assertPathCurrent(
  target: string,
  metadata: Stats,
): Promise<void> {
  if (
    (await realpath(target)) !== target ||
    !sameFile(await lstat(target), metadata)
  )
    invalid();
}
function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.ino === right.ino && left.dev === right.dev && left.mode === right.mode
  );
}
function virtualPath(root: string, filename: string): string {
  const suffix = relative(root, filename).split(sep).filter(Boolean).join("/");
  return suffix ? `${VIRTUAL_ROOT}/${suffix}` : VIRTUAL_ROOT;
}
function invalid(): never {
  throw new Error("desktop_sandbox_path_invalid");
}
