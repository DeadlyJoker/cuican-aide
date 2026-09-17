import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

// Match the existing readers. A successful write must remain readable on restart.
const CONFIG_LIMITS = new Map([
  ["provider-credentials.json", 512 * 1024],
  ["agent-platform-credentials.json", 256 * 1024],
  ["desktop-workspace.json", 16 * 1024],
  ["desktop-model-catalog-cache.json", 32 * 1024],
]);
const PENDING_SUFFIX = ".pending-v1";

/**
 * The desktop single-instance owner writes these files synchronously. Each
 * target has one exclusive staging slot, so crashes cannot create more slots.
 * A pending file is never committed state and is never promoted on startup.
 */
export function writeDesktopConfigAtomically(
  path: string,
  contents: string,
): void {
  const limit = CONFIG_LIMITS.get(basename(path));
  if (limit === undefined) throw new Error("desktop_config_target_invalid");
  if (Buffer.byteLength(contents) > limit) {
    throw new Error("desktop_config_too_large");
  }
  const temporary = `${path}${PENDING_SUFFIX}`;
  // EEXIST leaves an existing file, symlink, or other writer untouched.
  const descriptor = openSync(temporary, "wx", 0o600);
  let closed = false;
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    closed = true;
    renameSync(temporary, path);
  } catch (error) {
    if (!closed) {
      // Close before unlink for Windows. Preserve the original write failure.
      try {
        closeSync(descriptor);
      } catch {
        // A failed close may already have released the descriptor.
      }
    }
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (!hasCode(cleanupError, "ENOENT")) {
        throw new AggregateError(
          [error, cleanupError],
          "desktop_config_write_and_cleanup_failed",
        );
      }
    }
    throw error;
  }
}

/** Call once, after obtaining Electron's single-instance lock and before stores. */
export function discardInterruptedDesktopConfigWrites(options: {
  dataDirectory: string;
  ownsSingleInstance: boolean;
}): Readonly<{ removed: number; retained: number }> {
  if (!options.ownsSingleInstance) {
    throw new Error("desktop_config_instance_lock_required");
  }
  let removed = 0;
  let retained = 0;
  // Four exact paths; no directory enumeration, history reads, or age heuristic.
  for (const [name, limit] of CONFIG_LIMITS) {
    const temporary = join(options.dataDirectory, `${name}${PENDING_SUFFIX}`);
    try {
      const metadata = lstatSync(temporary);
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > limit) {
        retained += 1;
        continue;
      }
      unlinkSync(temporary);
      removed += 1;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) retained += 1;
    }
  }
  // Committed configuration remains usable if cleanup fails. The occupied
  // slot still rejects future writes, without creating more temporary files.
  return { removed, retained };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
