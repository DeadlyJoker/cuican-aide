/**
 * Desktop self-update, driven by the frontend.
 *
 * The shell registers the updater plugin but does not decide when to update:
 * a background check that restarts the app mid-turn would be hostile. So the
 * policy lives here, and it is deliberately one shape for every caller --
 * including the web build, where updating is meaningless. `web` reports
 * `unsupported` rather than throwing, so call sites render state instead of
 * branching on platform.
 */

/** Where the flow is. One value, so the UI never has to combine flags. */
export type UpdatePhase =
  | "idle"
  | "unsupported"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "failed";

export type UpdateState = {
  phase: UpdatePhase;
  /** Version offered by the manifest; absent unless one is on offer. */
  version?: string;
  /** Release notes from `latest.json`. */
  notes?: string;
  /** 0..1 while downloading. Absent when the total size is unknown. */
  progress?: number;
  error?: string;
};

/** The subset of the updater plugin this module needs. Injected, so it is testable. */
export type UpdateHandle = {
  version: string;
  notes?: string;
  /** Downloads and installs, reporting bytes as they arrive. */
  downloadAndInstall(
    onProgress: (event: DownloadProgress) => void,
  ): Promise<void>;
};

export type DownloadProgress =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export type UpdaterPort = {
  /** Resolves to `null` when the running version is already the latest. */
  check(): Promise<UpdateHandle | null>;
  relaunch(): Promise<void>;
};

export type ResolvedUpdate = {
  handle: UpdateHandle;
  port: UpdaterPort;
};

export type UpdaterPortResolver = () => Promise<UpdaterPort | null>;

export const IDLE_STATE: UpdateState = { phase: "idle" };
export const UNSUPPORTED_STATE: UpdateState = { phase: "unsupported" };

function failure(error: unknown): UpdateState {
  return {
    phase: "failed",
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Asks the manifest whether a newer build exists.
 *
 * `port` is `null` on web and anywhere else the updater is absent, which is why
 * this never throws: an unreachable endpoint is normal (offline, private
 * network) and must not surface as a crash.
 */
export async function checkForUpdate(
  port: UpdaterPort | null,
  emit: (state: UpdateState) => void,
): Promise<UpdateHandle | null> {
  if (port === null) {
    emit(UNSUPPORTED_STATE);
    return null;
  }

  emit({ phase: "checking" });
  try {
    const handle = await port.check();
    if (handle === null) {
      emit({ phase: "current" });
      return null;
    }
    emit({ phase: "available", version: handle.version, notes: handle.notes });
    return handle;
  } catch (error) {
    emit(failure(error));
    return null;
  }
}

/**
 * Resolves the desktop-only updater authority, then performs one user-requested
 * check. Keeping resolution in the action means opening Settings never imports
 * a Tauri plugin or contacts the update endpoint by itself.
 */
export async function checkDesktopUpdate(
  resolvePort: UpdaterPortResolver,
  emit: (state: UpdateState) => void,
): Promise<ResolvedUpdate | null> {
  try {
    const port = await resolvePort();
    const handle = await checkForUpdate(port, emit);
    return port && handle ? { handle, port } : null;
  } catch (error) {
    emit(failure(error));
    return null;
  }
}

/**
 * Tracks download progress as a fraction.
 *
 * Kept separate from the install call because the arithmetic is the only part
 * with edge cases worth testing: a manifest may omit `contentLength`, and
 * dividing by zero would put the UI at `Infinity`.
 */
export function createProgressTracker(): (
  event: DownloadProgress,
) => number | undefined {
  let total = 0;
  let received = 0;

  return (event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      received = 0;
      return total > 0 ? 0 : undefined;
    }
    if (event.event === "Progress") {
      received += event.data.chunkLength;
      return total > 0 ? Math.min(received / total, 1) : undefined;
    }
    return 1;
  };
}

/**
 * Downloads, installs, and relaunches.
 *
 * The relaunch is here rather than left to the caller because on Windows the
 * NSIS installer replaces the running binary: not restarting leaves a process
 * whose own files are gone.
 */
export async function installUpdate(
  port: UpdaterPort,
  handle: UpdateHandle,
  emit: (state: UpdateState) => void,
): Promise<void> {
  const track = createProgressTracker();
  const base = { version: handle.version, notes: handle.notes };

  try {
    emit({ phase: "downloading", ...base, progress: 0 });
    await handle.downloadAndInstall((event) => {
      emit({ phase: "downloading", ...base, progress: track(event) });
    });
    emit({ phase: "ready", ...base });
    await port.relaunch();
  } catch (error) {
    emit(failure(error));
  }
}
