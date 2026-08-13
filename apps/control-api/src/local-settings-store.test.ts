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
