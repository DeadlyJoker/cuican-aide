import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface OutboxAvailabilityHintPort {
  /** A hint only: the receiver must claim and validate the durable Outbox. */
  notifyAvailability(): void;
}

export type SqliteOutboxWatchFactory = (
  databasePath: string,
  onChange: (filename: string | null) => void,
  onError: () => void,
) => Readonly<{ close(): void }>;

/** Observe shared-file changes without opening the database or reading event contents. */
export function watchSqliteOutboxAvailability(
  input: Readonly<{
    databasePath: string;
    outbox: OutboxAvailabilityHintPort;
    watchFactory?: SqliteOutboxWatchFactory;
  }>,
): Readonly<{
  status(): "watching" | "unavailable" | "closed" | "memory";
  close(): void;
}> {
  let handle: ReturnType<SqliteOutboxWatchFactory> | null = null;
  let closed = false;
  let unavailable = false;
  const memory = input.databasePath === ":memory:";
  const retire = () => {
    const current = handle;
    handle = null;
    try {
      current?.close();
    } catch {
      // The regular durable scanner remains the recovery mechanism.
    }
  };
  if (!memory) {
    const path = resolve(input.databasePath);
    const file = basename(path);
    const names = new Set([file, `${file}-wal`, `${file}-journal`]);
    try {
      // Watching the directory also observes WAL replacement and checkpoints.
      const opened = (input.watchFactory ?? systemWatchFactory)(
        path,
        (name) => {
          if (closed || unavailable || (name !== null && !names.has(name)))
            return;
          try {
            input.outbox.notifyAvailability();
          } catch {
            // Notification cannot undo a committed worker operation.
          }
        },
        () => {
          unavailable = true;
          retire();
        },
      );
      if (closed || unavailable) opened.close();
      else handle = opened;
    } catch {
      unavailable = true;
      retire();
    }
  }
  return {
    status: () =>
      closed
        ? "closed"
        : memory
          ? "memory"
          : unavailable
            ? "unavailable"
            : "watching",
    close: () => {
      if (closed) return;
      closed = true;
      retire();
    },
  };
}

const systemWatchFactory: SqliteOutboxWatchFactory = (
  databasePath,
  onChange,
  onError,
) => {
  const paths = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-journal`,
  ];
  const files = new Map<
    string,
    Readonly<{ watcher: FSWatcher; inode: string }>
  >();
  let closed = false;
  const retireFile = (path: string) => {
    const current = files.get(path);
    files.delete(path);
    current?.watcher.close();
  };
  const observeFile = (path: string) => {
    if (closed) return;
    try {
      const metadata = statSync(path, { bigint: true });
      const inode = `${metadata.dev}:${metadata.ino}`;
      if (files.get(path)?.inode === inode) return;
      retireFile(path);
      const file = watch(path, { persistent: false }, (event) => {
        if (closed || files.get(path)?.watcher !== file) return;
        onChange(basename(path));
        if (event === "rename") {
          observeFile(path);
        }
      });
      files.set(path, { watcher: file, inode });
      file.on("error", () => {
        if (files.get(path)?.watcher !== file) return;
        retireFile(path);
        if (!closed) onChange(basename(path));
      });
    } catch {
      retireFile(path);
      // WAL/journal files may not exist yet. The directory observes creation.
    }
  };
  // macOS directory watches observe replacement but may omit child-file writes.
  const directory = watch(
    dirname(databasePath),
    { persistent: false },
    (_event, filename) => {
      if (closed) return;
      const name = filename === null ? null : filename.toString();
      if (name === null || paths.some((path) => basename(path) === name)) {
        for (const path of paths) observeFile(path);
        onChange(name);
      }
    },
  );
  directory.on("error", onError);
  for (const path of paths) observeFile(path);
  return {
    close: () => {
      if (closed) return;
      closed = true;
      directory.close();
      for (const path of [...files.keys()]) retireFile(path);
    },
  };
};
