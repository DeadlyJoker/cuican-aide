import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { guardianPath, parseDevUiEnvironment } from "./crewon-desktop-dev.mjs";

test("loads only exact public Vite development settings", () => {
  assert.deepEqual(
    parseDevUiEnvironment(
      "# local browser flags\nVITE_CREWON_PRINCIPAL_SESSION_ENABLED=true\n",
    ),
    { VITE_CREWON_PRINCIPAL_SESSION_ENABLED: "true" },
  );
  for (const source of [
    "SERVER_SECRET=leak\n",
    "VITE_CREWON_FLAG=one\nVITE_CREWON_FLAG=two\n",
    "VITE_CREWON_FLAG=$(cat secret)\n",
    " VITE_CREWON_FLAG=true\n",
  ]) {
    assert.throws(() => parseDevUiEnvironment(source));
  }
});

test("resolves the guardian artifact for each desktop platform", () => {
  assert.equal(
    guardianPath("/tmp/target", "darwin"),
    join("/tmp/target", "debug", "crewon-process-guardian"),
  );
  assert.equal(
    guardianPath("C:\\target", "win32"),
    join("C:\\target", "debug", "crewon-process-guardian.exe"),
  );
});
