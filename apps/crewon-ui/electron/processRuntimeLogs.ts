import {
  RuntimeLogForwarder,
  type RuntimeLogSink,
} from "./runtimeLogForwarder.ts";
import { RuntimeLogProcess } from "./runtimeLogProcess.ts";

let shared: {
  writer: RuntimeLogProcess;
  forwarder: RuntimeLogForwarder;
  sink: RuntimeLogSink;
} | null = null;

/** Share buffering and the lazy writer across Supervisor restarts and catalog probes. */
export function processRuntimeLogs(): RuntimeLogSink {
  if (shared !== null) return shared.sink;
  const writer = new RuntimeLogProcess({
    entry: new URL(
      import.meta.url.endsWith(".ts")
        ? "./runtimeLogWriter.ts"
        : "./runtimeLogWriter.mjs",
      import.meta.url,
    ),
  });
  const forwarder = new RuntimeLogForwarder(writer.outputs);
  const sink: RuntimeLogSink = {
    write: (...args) => forwarder.write(...args),
    status: () => forwarder.status(),
    // This destination belongs to the whole process, not any single runtime generation.
    resume() {},
    suspend() {},
  };
  shared = { writer, forwarder, sink };
  return sink;
}

export function processRuntimeLogStatus() {
  return shared === null
    ? null
    : { outputs: shared.forwarder.status(), writer: shared.writer.snapshot() };
}

export function closeProcessRuntimeLogs(): void {
  shared?.forwarder.suspend();
  void shared?.writer.close();
}
