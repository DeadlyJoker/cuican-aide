import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [pidFile, mode] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize" && mode === "initializeHang") return;
  let result;
  if (request.method === "initialize" && mode !== "initializeFailure") {
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "creation-fixture", version: "1" },
    };
  } else if (request.method === "tools/list" && mode !== "catalogFailure") {
    result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  }
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      ...(result === undefined
        ? { error: { code: -32603, message: "fixture_creation_failure" } }
        : { result }),
    }) + "\n",
  );
});
if (mode === "initializeFailure") {
  // Exercise SDK automatic close and its TERM/KILL fallback, not just a
  // cooperative server that exits immediately on EOF.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdin.on("end", () => process.exit(0));
}
