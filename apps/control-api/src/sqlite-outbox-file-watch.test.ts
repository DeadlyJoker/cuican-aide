import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { watchSqliteOutboxAvailability } from "./sqlite-outbox-wakeup.ts";

test("real SQLite WAL removal, recreation and subsequent in-place commits continue emitting hints", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-wal-replacement-"));
  const path = join(directory, "control.sqlite");
  const original = new DatabaseSync(path);
  let originalClosed = false;
  original.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE wake_fixture(value INTEGER)",
  );
  assert.equal(existsSync(`${path}-wal`), true);
  let hints = 0;
  let pending: (() => void) | null = null;
  const owner = watchSqliteOutboxAvailability({
    databasePath: path,
    outbox: {
      notifyAvailability: () => {
        hints++;
        pending?.();
        pending = null;
      },
    },
  });
  let reopened: DatabaseSync | null = null;
  context.after(async () => {
    owner.close();
    if (!originalClosed) original.close();
    reopened?.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(owner.status(), "watching");
  // macOS installs native watches asynchronously. A write in watch()'s initial
  // event-loop turn can be missed; the durable scanner covers that startup gap.
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Prove the native watch is active before replacing the WAL inode.
  const initial = nextHint("initial-commit");
  original.exec("INSERT INTO wake_fixture VALUES(0)");
  await initial;
  original.close();
  originalClosed = true;
  assert.equal(existsSync(`${path}-wal`), false);
  // Native notifications may coalesce removal and recreation. What matters is
  // that the recreated WAL and its later in-place commits remain observable.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const recreated = nextHint("recreated");
  reopened = new DatabaseSync(path);
  reopened.exec("INSERT INTO wake_fixture VALUES(1)");
  assert.equal(existsSync(`${path}-wal`), true);
  await recreated;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = hints;
  const committed = nextHint("committed");
  reopened.exec("INSERT INTO wake_fixture VALUES(2)");
  await committed;
  assert.ok(hints > before);
  assert.equal(owner.status(), "watching");

  function nextHint(stage: string) {
    let timer: NodeJS.Timeout | undefined;
    return new Promise<void>((resolve, reject) => {
      pending = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        pending = null;
        reject(new Error(`wal_hint_deadline:${stage}`));
      }, 2000);
    });
  }
});
