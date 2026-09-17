import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

writeFileSync(process.argv[2], String(process.pid), { mode: 0o600 });
const server = new Server(
  { name: "retirement-fixture", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", inputSchema: { type: "object" } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: "result" }],
}));
await server.connect(new StdioServerTransport());
process.stdin.once("end", () => {
  void server.close();
});
