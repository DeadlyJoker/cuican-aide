import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mcp-lifetime-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
let cancellations = 0;
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "fixture", inputSchema: { type: "object" } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.arguments?.mode === "crash") process.exit(17);
  if (request.params.arguments?.mode === "hang") {
    writeFileSync(process.argv[2], "started");
    await new Promise((resolve) =>
      extra.signal.addEventListener("abort", resolve, { once: true }),
    );
  }
  return {
    content: [{ type: "text", text: "fixture" }],
    structuredContent: { cancellations },
  };
});
const transport = new StdioServerTransport();
await server.connect(transport);
const onmessage = transport.onmessage;
transport.onmessage = (...args) => {
  if (args[0]?.method === "notifications/cancelled") cancellations++;
  onmessage?.(...args);
};
process.stdin.once("end", () => {
  void server.close();
});
