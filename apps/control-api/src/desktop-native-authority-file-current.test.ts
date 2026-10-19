import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { captureNativeAuthorityFile } from "./desktop-native-plugin-authority-files.ts";

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(
    join(fs.realpathSync(tmpdir()), "crewon-authority-current-"),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "approval.json");
  fs.writeFileSync(path, '{"state":"allow"}', { mode: 0o600 });
  return path;
}

test(
  "unchanged private authority remains checked on every call without reopening or copying its bytes",
  { skip: process.platform === "win32" },
  (t) => {
    const path = fixture(t);
    const file = captureNativeAuthorityFile(path, 1024);
    const opens = t.mock.method(fs, "openSync");
    const reads = t.mock.method(fs, "readSync");
    const stats = t.mock.method(fs, "lstatSync");
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    for (let i = 0; i < 100; i++) file.assertCurrent();
    assert.equal(opens.mock.calls.length, 0);
    assert.equal(reads.mock.calls.length, 0);
    assert.ok(stats.mock.calls.length >= 200);
  },
);

test(
  "same-length approval edits with restored mtime still revoke the captured authority",
  { skip: process.platform === "win32" },
  (t) => {
    const path = fixture(t);
    const stamp = 1_700_000_000;
    fs.utimesSync(path, stamp, stamp);
    const before = fs.lstatSync(path, { bigint: true });
    const file = captureNativeAuthorityFile(path, 1024);
    fs.writeFileSync(path, '{"state":"block"}');
    fs.utimesSync(path, stamp, stamp);
    const after = fs.lstatSync(path, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.notEqual(after.ctimeNs, before.ctimeNs);
    assert.throws(() => file.assertCurrent(), /file_changed/u);
  },
);
