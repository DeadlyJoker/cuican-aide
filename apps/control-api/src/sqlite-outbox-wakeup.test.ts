import assert from "node:assert/strict";
import test from "node:test";

import {
  watchSqliteOutboxAvailability,
  type SqliteOutboxWatchFactory,
} from "./sqlite-outbox-wakeup.ts";

function fakeWatch() {
  let changed: (name: string | null) => void = () => {};
  let failed = () => {};
  let closes = 0;
  let directory: string | null = null;
  const watchFactory: SqliteOutboxWatchFactory = (path, onChange, onError) => {
    directory = path;
    changed = onChange;
    failed = onError;
    return { close: () => void (closes += 1) };
  };
  return {
    watchFactory,
    changed: (name: string | null) => changed(name),
    failed: () => failed(),
    closes: () => closes,
    directory: () => directory,
  };
}

test("only database, WAL, journal and unnamed changes emit non-authoritative hints", () => {
  const files = fakeWatch();
  let hints = 0;
  const owner = watchSqliteOutboxAvailability({
    databasePath: "/tmp/crewon-wake/control.sqlite",
    outbox: { notifyAvailability: () => void (hints += 1) },
    watchFactory: files.watchFactory,
  });
  assert.equal(files.directory(), "/tmp/crewon-wake/control.sqlite");
  assert.equal(owner.status(), "watching");
  for (const name of [
    "control.sqlite-shm",
    "other.sqlite-wal",
    "../control.sqlite",
  ])
    files.changed(name);
  assert.equal(hints, 0);
  for (const name of [
    "control.sqlite",
    "control.sqlite-wal",
    "control.sqlite-journal",
    null,
  ])
    files.changed(name);
  assert.equal(hints, 4);
  owner.close();
  owner.close();
  files.changed("control.sqlite-wal");
  assert.equal(hints, 4);
  assert.equal(files.closes(), 1);
  assert.equal(owner.status(), "closed");
});

test("WAL deletion and recreation stay observable through the directory watch", () => {
  const files = fakeWatch();
  let hints = 0;
  const owner = watchSqliteOutboxAvailability({
    databasePath: "/tmp/crewon-wake/control.sqlite",
    outbox: { notifyAvailability: () => void (hints += 1) },
    watchFactory: files.watchFactory,
  });
  files.changed("control.sqlite-wal");
  files.changed("control.sqlite");
  files.changed("control.sqlite-wal");
  assert.equal(hints, 3);
  assert.equal(files.closes(), 0);
  owner.close();
});

test("watch errors retire the hint channel without throwing or authorizing output", () => {
  const files = fakeWatch();
  let hints = 0;
  const owner = watchSqliteOutboxAvailability({
    databasePath: "/tmp/crewon-wake/control.sqlite",
    outbox: { notifyAvailability: () => void (hints += 1) },
    watchFactory: files.watchFactory,
  });
  files.failed();
  files.changed("control.sqlite-wal");
  files.failed();
  assert.equal(hints, 0);
  assert.equal(files.closes(), 1);
  assert.equal(owner.status(), "unavailable");
  owner.close();
  assert.equal(files.closes(), 1);
});

test("watch creation failure and synchronous watch failure remain recoverable by scanning", () => {
  const failed = watchSqliteOutboxAvailability({
    databasePath: "/tmp/crewon-wake/control.sqlite",
    outbox: { notifyAvailability: () => assert.fail("must not notify") },
    watchFactory: () => {
      throw new Error("watch_unavailable");
    },
  });
  assert.equal(failed.status(), "unavailable");
  failed.close();
  let closed = 0;
  const synchronous = watchSqliteOutboxAvailability({
    databasePath: "/tmp/crewon-wake/control.sqlite",
    outbox: { notifyAvailability: () => assert.fail("must not notify") },
    watchFactory: (_directory, _changed, error) => {
      error();
      return { close: () => void (closed += 1) };
    },
  });
  assert.equal(synchronous.status(), "unavailable");
  assert.equal(closed, 1);
  synchronous.close();
  assert.equal(closed, 1);
});

test("memory databases do not create a file watcher", () => {
  const owner = watchSqliteOutboxAvailability({
    databasePath: ":memory:",
    outbox: { notifyAvailability: () => assert.fail("must not notify") },
    watchFactory: () => {
      throw new Error("must not watch");
    },
  });
  assert.equal(owner.status(), "memory");
  owner.close();
});

test("a notification failure cannot escape into the filesystem callback", () => {
  const files = fakeWatch();
  const owner = watchSqliteOutboxAvailability({
    databasePath: "/tmp/crewon-wake/control.sqlite",
    outbox: {
      notifyAvailability: () => {
        throw new Error("owner_retired");
      },
    },
    watchFactory: files.watchFactory,
  });
  assert.doesNotThrow(() => files.changed("control.sqlite-wal"));
  owner.close();
});
