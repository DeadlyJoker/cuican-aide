import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runMediaInspectionProcess } from "./media-inspection-process.ts";

test(
  "cancellation settles only after the actual child has exited",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "crewon-inspection-process-fixture-"),
    );
    t.after(() => rm(directory, { recursive: true }));
    const path = join(directory, "named-child-pid.txt");
    const controller = new AbortController();
    const pending = runMediaInspectionProcess({
      executable: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000);",
        path,
      ],
      source: { kind: "bytes", bytes: Buffer.alloc(0) },
      maxOutputBytes: 0,
      signal: controller.signal,
    });
    const canceled = assert.rejects(pending, { code: "canceled" });
    t.after(() => {
      controller.abort();
      return canceled;
    });
    let pid: number | null = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && pid === null) {
      try {
        pid = Number(await readFile(path, "utf8"));
      } catch {
        await delay(5);
      }
    }
    assert.ok(pid !== null && Number.isInteger(pid) && pid > 0);
    process.kill(pid!, 0);
    controller.abort();
    await canceled;
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  },
);

test("unbounded child output is stopped with a sanitized error", async () => {
  await assert.rejects(
    runMediaInspectionProcess({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('named-test-output-too-long'); setInterval(()=>{},1000);",
      ],
      source: { kind: "bytes", bytes: Buffer.alloc(0) },
      maxOutputBytes: 8,
      signal: AbortSignal.timeout(3000),
    }),
    { code: "output_too_large", message: "output_too_large" },
  );
});
