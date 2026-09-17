import { writeSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { setImmediate as turn } from "node:timers/promises";
import { RuntimeLogForwarder } from "./runtimeLogForwarder.ts";
import { RuntimeLogProcess } from "./runtimeLogProcess.ts";
import {
  processRuntimeLogs,
  processRuntimeLogStatus,
} from "./processRuntimeLogs.ts";

const mode = process.argv[2];
const writer =
  mode === "legacy" || mode === "shared"
    ? null
    : new RuntimeLogProcess({
        entry: new URL(
          mode === "synchronous"
            ? "./runtimeLogSynchronousWriter.test-support.ts"
            : "./runtimeLogWriter.ts",
          import.meta.url,
        ),
        stdout: 4,
        stderr: 5,
      });
const blocking = (fd: number) =>
  new Writable({
    write(chunk: Buffer, _encoding, done) {
      writeSync(fd, chunk);
      done();
    },
  });
const logs =
  mode === "shared"
    ? processRuntimeLogs()
    : new RuntimeLogForwarder(
        writer?.outputs ?? { stdout: blocking(4), stderr: blocking(5) },
      );
process.on("message", (message) => {
  if (message === "ping")
    process.send!({
      kind: "pong",
      outputs: logs.status(),
      writer: writer?.snapshot() ?? processRuntimeLogStatus()?.writer,
      shared: mode === "shared" ? logs === processRuntimeLogs() : undefined,
    });
  if (message === "stop") {
    logs.suspend();
    process.disconnect!();
  }
});
process.send!({ kind: "started" });
const chunk = Buffer.alloc(64 * 1024, 65);
let recordedHelper = false;
for (let n = 0; n < 1024; n++) {
  logs.write(n % 2 ? "stdout" : "stderr", "Worker", chunk);
  if (mode === "shared") {
    logs.suspend();
    logs.resume();
  }
  await turn();
  const pid = writer?.snapshot().pid ?? processRuntimeLogStatus()?.writer.pid;
  if (!recordedHelper && pid) {
    writeFileSync(
      process.argv[3],
      JSON.stringify({ host: process.pid, helper: pid }),
    );
    recordedHelper = true;
  }
}
process.send!({ kind: "flooded" });
