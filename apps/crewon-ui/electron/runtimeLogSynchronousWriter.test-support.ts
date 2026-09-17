import { writeSync } from "node:fs";
import type { RuntimeLogWrite } from "./runtimeLogProtocol.ts";

// Fault injection: an actual blocking kernel write, not an unresolved JS callback.
process.on("message", (message: RuntimeLogWrite) => {
  writeSync(message.channel === "stdout" ? 1 : 2, message.bytes);
  process.send!({
    kind: "written",
    id: message.id,
    channel: message.channel,
    failed: false,
    rssBytes: process.memoryUsage.rss(),
  });
});
