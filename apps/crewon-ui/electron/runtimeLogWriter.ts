import { write } from "node:fs";
import {
  MAX_RUNTIME_LOG_WRITE_BYTES,
  type RuntimeLogWrite,
  type RuntimeLogWritten,
} from "./runtimeLogProtocol.ts";

// Only diagnostic bytes enter this process. Never execute tools or parse model streams here.
if (process.send === undefined) throw new Error("runtime_log_ipc_required");
const active = new Set<string>();
let rssBytes = process.memoryUsage.rss(),
  sampledAt = Date.now();
// Async descriptor writes keep this loop free to notice parent death. SIGKILL also
// ends a native write stalled in this helper's isolated libuv pool.
const stop = () => {
  process.kill(process.pid, "SIGKILL");
};
process.on("disconnect", stop);
process.on("message", (input: unknown) => {
  const message = input as Partial<RuntimeLogWrite> | null;
  if (
    message === null ||
    typeof message !== "object" ||
    message.kind !== "write" ||
    !Number.isSafeInteger(message.id) ||
    message.id! < 1 ||
    (message.channel !== "stdout" && message.channel !== "stderr") ||
    !(message.bytes instanceof Uint8Array) ||
    message.bytes.byteLength < 1 ||
    message.bytes.byteLength > MAX_RUNTIME_LOG_WRITE_BYTES ||
    active.has(message.channel)
  ) {
    stop();
    return;
  }
  active.add(message.channel);
  const finish = (failed: boolean) => {
    active.delete(message.channel!);
    // ACK, not IPC send completion, permits the next bounded chunk.
    if (Date.now() - sampledAt >= 5000) {
      rssBytes = process.memoryUsage.rss();
      sampledAt = Date.now();
    }
    process.send!(
      {
        kind: "written",
        id: message.id!,
        channel: message.channel!,
        failed,
        rssBytes,
      } satisfies RuntimeLogWritten,
      (error) => {
        if (error) stop();
      },
    );
  };
  const bytes = message.bytes!;
  let offset = 0;
  const append = () => {
    write(
      message.channel === "stdout" ? 1 : 2,
      bytes,
      offset,
      bytes.length - offset,
      null,
      (error, written) => {
        if (error) {
          if (["EAGAIN", "EWOULDBLOCK", "EINTR"].includes(error.code ?? "")) {
            setTimeout(append, 50);
            return;
          }
          finish(true);
          return;
        }
        if (written < 1) {
          finish(true);
          return;
        }
        offset += written;
        if (offset < bytes.length) append();
        else finish(false);
      },
    );
  };
  append();
});
