import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "crewon-mcp-test-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
let invocations = 0;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Returns deterministic structured input.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  invocations += 1;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          echo: request.params.arguments?.value,
          invocations,
        }),
      },
    ],
    structuredContent: {
      echoed: request.params.arguments?.value,
    },
  };
});

await server.connect(new StdioServerTransport());
