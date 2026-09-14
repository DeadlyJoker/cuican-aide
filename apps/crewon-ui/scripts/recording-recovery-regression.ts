import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RecordingStore } from "../electron/recordingStore.ts";
import { recordingPage } from "../electron/recordingNavigation.ts";

const mode = process.argv[2];
if (mode === "write") {
  const store = new RecordingStore(process.argv[3]!);
  await store.initialize();
  await store.start("https://synthetic.example");
  await store.append({
    kind: "download",
    page: recordingPage("https://synthetic.example/orders?date=2026-09-01"),
    target: null,
    input: null,
    note: null,
    outcome: "unknown",
    reason: null,
    relatedStepId: null,
  });
  process.stdout.write("READY");
  setInterval(() => {}, 1000);
} else if (mode === "read") {
  const store = new RecordingStore(process.argv[3]!);
  await store.initialize();
  assert.equal(store.current!.status, "interrupted");
  assert.equal(store.current!.steps[0]!.outcome, "unknown");
  assert.equal(store.current!.revision, 3);
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      recordingStatus: store.current!.status,
      downloadOutcome: store.current!.steps[0]!.outcome,
      revision: store.current!.revision,
    }),
  );
} else {
  const directory = await mkdtemp(join(tmpdir(), "crewon-recording-recovery-"));
  const executable = fileURLToPath(import.meta.url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [executable, "write", directory], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = false;
    child.stdout.on("data", (data) => {
      if (data.toString().includes("READY")) {
        ready = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", reject);
    child.once("exit", (_code, signal) =>
      ready && signal === "SIGKILL"
        ? resolve()
        : reject(new Error("crash fixture failed")),
    );
  });
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [executable, "read", directory]);
    let text = "";
    child.stdout.on("data", (data) => (text += data.toString()));
    child.stderr.on("data", (data) => process.stderr.write(data));
    child.once("exit", (code) =>
      code === 0 ? resolve(text) : reject(new Error("recovery failed")),
    );
  });
  const output = resolve(process.env.F02_REPO_ROOT!, "artifacts/f02-recording");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "recovery-result.json"), result);
  console.log(result);
}
