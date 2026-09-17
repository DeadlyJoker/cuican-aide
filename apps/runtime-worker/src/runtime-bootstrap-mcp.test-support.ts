import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [pidFile, closingFile, delayText, releaseFile] = process.argv.slice(2);
writeFileSync(pidFile!, String(process.pid), { mode: 0o600 });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line: string) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "bootstrap-fixture", version: "1" },
        }
      : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
});
process.stdin.on("end", () => {
  writeFileSync(closingFile!, String(Date.now()), { mode: 0o600 });
  if (releaseFile === undefined) {
    setTimeout(() => process.exit(0), Number(delayText));
  } else {
    const check = setInterval(() => {
      if (!existsSync(releaseFile)) return;
      clearInterval(check);
      process.exit(0);
    }, 10);
  }
});
