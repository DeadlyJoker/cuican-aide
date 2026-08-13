import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalSettingsStore } from "./local-settings-store.ts";

test("persists the standalone local settings snapshot with CAS", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "crewon-local-settings-")),
    "control.sqlite",
  );
  const store = new LocalSettingsStore(path);
  assert.deepEqual(store.get(), {
    locale: "zh",
    theme: "light",
    revision: 0,
    updatedAt: null,
  });
  const saved = store.put({ locale: "en", theme: "dark", expectedRevision: 0 });
  assert.deepEqual(store.get(), saved);
  assert.throws(
    () => store.put({ locale: "zh", theme: "light", expectedRevision: 0 }),
    /revision_conflict/,
  );
  store.close();
  const reopened = new LocalSettingsStore(path);
  assert.deepEqual(reopened.get(), saved);
  reopened.close();
});

test("allows only one Store instance to win the same revision", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "crewon-local-settings-race-")),
    "control.sqlite",
  );
  const first = new LocalSettingsStore(path);
  const second = new LocalSettingsStore(path);
  const winner = first.put({
    locale: "en",
    theme: "dark",
    expectedRevision: 0,
  });
  assert.throws(
    () =>
      second.put({
        locale: "zh",
        theme: "light",
        expectedRevision: 0,
      }),
    /local_settings_revision_conflict/,
  );
  assert.deepEqual(second.get(), winner);
  first.close();
  second.close();
});
