import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearRuntimeReadinessFile,
  markRuntimeReady,
  resolveRuntimeReadinessFile,
  RUNTIME_READINESS_FILE_ENV,
} from "./runtime-readiness-file.ts";

test("publishes readiness atomically and removes it on shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-worker-ready-"));
  const path = join(directory, "worker.ready");
  try {
    assert.equal(
      resolveRuntimeReadinessFile({ [RUNTIME_READINESS_FILE_ENV]: path }),
      path,
    );
    await clearRuntimeReadinessFile(path);
    await writeFile(`${path}.${process.pid}.tmp`, "stale", "utf8");
    await markRuntimeReady(path);
    assert.equal(await readFile(path, "utf8"), `${process.pid}\n`);
    await clearRuntimeReadinessFile(path);
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid readiness paths and leaves the feature opt-in", () => {
  assert.equal(resolveRuntimeReadinessFile({}), null);
  for (const path of ["", "relative/worker.ready", `/${"x".repeat(1025)}`]) {
    assert.throws(
      () => resolveRuntimeReadinessFile({ [RUNTIME_READINESS_FILE_ENV]: path }),
      new RegExp(`${RUNTIME_READINESS_FILE_ENV}_invalid`, "u"),
    );
  }
});
