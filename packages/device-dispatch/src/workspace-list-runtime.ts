import {
  WORKSPACE_LIST_HARD_LIMITS,
  WorkspaceListExecutionError,
  type WorkspaceDirectoryCapabilityPort,
  type WorkspaceDirectoryEntry,
  type WorkspaceListCleanupFailureReporterPort,
  type WorkspaceListDeadlineSchedulerPort,
  type WorkspaceListLimits,
  type WorkspaceListResult,
} from "./workspace-list-types.ts";
import { compareBytes, hasExactKeys, utf8 } from "./workspace-list-protocol.ts";

type CollectedEntry = Readonly<{
  name: string;
  nameBytes: Uint8Array;
  kind: "file" | "directory";
}>;

export async function collectEntries(
  capability: WorkspaceDirectoryCapabilityPort,
  limits: WorkspaceListLimits,
  signal: AbortSignal,
): Promise<CollectedEntry[]> {
  const entries: CollectedEntry[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let scannedNameBytes = 0;
  let cursor: string | null = null;
  while (true) {
    const remaining = limits.maxScannedEntries - entries.length;
    if (remaining < 1) {
      throw new WorkspaceListExecutionError(
        "workspace_list_scan_limit_exceeded",
      );
    }
    const remainingNameBytes = limits.maxScannedNameBytes - scannedNameBytes;
    if (remainingNameBytes < 1) {
      throw new WorkspaceListExecutionError(
        "workspace_list_scan_bytes_exceeded",
      );
    }
    const page: unknown = await raceAbort(
      capability.listTopLevelPage({
        cursor,
        limit: remaining,
        maxNameBytes: limits.maxNameBytes,
        maxTotalNameBytes: remainingNameBytes,
        signal,
      }),
      signal,
    );
    if (
      !hasExactKeys(page, ["entries", "nextCursor"]) ||
      !Array.isArray(page.entries) ||
      page.entries.length > remaining ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(page.nextCursor)))
    ) {
      throw new WorkspaceListExecutionError("workspace_list_page_invalid");
    }
    for (const candidate of page.entries) {
      const entry = parseDirectoryEntry(candidate, limits.maxNameBytes);
      scannedNameBytes += entry.nameBytes.byteLength;
      if (scannedNameBytes > limits.maxScannedNameBytes) {
        throw new WorkspaceListExecutionError(
          "workspace_list_scan_bytes_exceeded",
        );
      }
      const nameKey = Buffer.from(entry.nameBytes).toString("hex");
      if (names.has(nameKey)) {
        throw new WorkspaceListExecutionError("workspace_list_entry_duplicate");
      }
      names.add(nameKey);
      entries.push(entry);
    }
    if (page.nextCursor === null) return entries;
    if (
      page.entries.length === 0 ||
      cursors.has(page.nextCursor) ||
      entries.length >= limits.maxScannedEntries
    ) {
      throw new WorkspaceListExecutionError(
        "workspace_list_scan_limit_exceeded",
      );
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function parseDirectoryEntry(
  input: WorkspaceDirectoryEntry,
  maxNameBytes: number,
): CollectedEntry {
  if (!hasExactKeys(input, ["kind", "nameBytes"])) {
    throw new WorkspaceListExecutionError("workspace_list_entry_invalid");
  }
  if (input.kind === "symlink" || input.kind === "reparsePoint") {
    throw new WorkspaceListExecutionError(
      "workspace_list_link_entry_unsupported",
    );
  }
  if (input.kind !== "file" && input.kind !== "directory") {
    throw new WorkspaceListExecutionError(
      "workspace_list_entry_type_unsupported",
    );
  }
  if (
    !(input.nameBytes instanceof Uint8Array) ||
    input.nameBytes.byteLength < 1 ||
    input.nameBytes.byteLength > maxNameBytes
  ) {
    throw new WorkspaceListExecutionError("workspace_list_entry_name_invalid");
  }
  const nameBytes = Uint8Array.from(input.nameBytes);
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch (error) {
    throw new WorkspaceListExecutionError("workspace_list_entry_name_invalid", {
      cause: error,
    });
  }
  if (
    name === "." ||
    name === ".." ||
    /[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ||
    compareBytes(nameBytes, utf8(name)) !== 0
  ) {
    throw new WorkspaceListExecutionError("workspace_list_entry_name_invalid");
  }
  return { name, nameBytes, kind: input.kind };
}

export function parseProjectedEntry(
  input: unknown,
): WorkspaceListResult["entries"][number] {
  if (
    !hasExactKeys(input, ["kind", "name"]) ||
    (input.kind !== "file" && input.kind !== "directory") ||
    typeof input.name !== "string"
  ) {
    throw new WorkspaceListExecutionError("workspace_list_result_invalid");
  }
  const parsed = parseDirectoryEntry(
    { nameBytes: utf8(input.name), kind: input.kind },
    WORKSPACE_LIST_HARD_LIMITS.maxNameBytes,
  );
  if (parsed.name !== input.name) {
    throw new WorkspaceListExecutionError("workspace_list_entry_name_invalid");
  }
  return { name: input.name, kind: input.kind };
}

export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortedError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortedError(signal.reason));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function acquireWithAbort(
  promise: Promise<WorkspaceDirectoryCapabilityPort | null>,
  signal: AbortSignal,
  cleanupFailures: WorkspaceListCleanupFailureReporterPort,
): Promise<WorkspaceDirectoryCapabilityPort | null> {
  if (signal.aborted) {
    void promise.then(
      async (capability) => {
        const error = await releaseCapability(capability);
        if (error !== null) {
          reportCleanupFailure(cleanupFailures, "lateAcquire", error);
        }
      },
      () => {},
    );
    return Promise.reject(abortedError(signal.reason));
  }
  return new Promise((resolve, reject) => {
    let ownershipTransferred = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (ownershipTransferred) return;
      ownershipTransferred = true;
      cleanup();
      reject(abortedError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (capability) => {
        if (ownershipTransferred) {
          void releaseCapability(capability).then((error) => {
            if (error !== null) {
              reportCleanupFailure(cleanupFailures, "lateAcquire", error);
            }
          });
          return;
        }
        ownershipTransferred = true;
        cleanup();
        resolve(capability);
      },
      (error: unknown) => {
        if (ownershipTransferred) return;
        ownershipTransferred = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export async function releaseCapability(
  capability: WorkspaceDirectoryCapabilityPort | null,
): Promise<unknown | null> {
  if (capability === null) return null;
  try {
    await capability.release();
    return null;
  } catch (error) {
    return error;
  }
}

export function reportCleanupFailure(
  reporter: WorkspaceListCleanupFailureReporterPort,
  phase: Parameters<
    WorkspaceListCleanupFailureReporterPort["report"]
  >[0]["phase"],
  error: unknown,
): void {
  try {
    reporter.report({ phase, error });
  } catch {}
}

export function abortedError(reason: unknown): WorkspaceListExecutionError {
  return new WorkspaceListExecutionError(
    reason === "workspace_list_deadline_exceeded"
      ? "workspace_list_deadline_exceeded"
      : "workspace_list_canceled",
  );
}

export const systemDeadlineScheduler: WorkspaceListDeadlineSchedulerPort = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
