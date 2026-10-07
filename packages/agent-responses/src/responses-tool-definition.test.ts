import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRequest } from "@crewon/agent-kernel";
import { toResponsesToolDefinition } from "./responses-tool-definition.ts";
import { DirectResponsesTransport } from "./direct-responses-transport.ts";

const source = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["brief", "text"] },
    briefRevision: { type: "integer" },
    artifactId: { type: "string" },
    contentRevision: { type: "integer" },
  },
  required: ["kind"],
  additionalProperties: false,
};
const definition = (
  inputSchema: Extract<
    ModelRequest["tools"][number],
    { kind: "function" }
  >["inputSchema"],
): ModelRequest["tools"][number] => ({
  schemaVersion: "crewon.tool-definition.v0",
  kind: "function",
  name: "content_read",
  description: "Read one project revision",
  execution: "serial",
  inputSchema,
});

test("streamed Responses request preserves optional project fields and receives a minimal brief call", async () => {
  const input = JSON.stringify({
    source: { kind: "brief", briefRevision: 1 },
    offset: 0,
  });
  const transport = new DirectResponsesTransport(
    { endpoint: "https://provider.example/v1/responses", model: "model" },
    {
      fetch: async (_, init) => {
        const request = JSON.parse(String(init?.body));
        assert.equal(request.tools[0].strict, false);
        assert.deepEqual(
          request.tools[0].parameters.properties.source.required,
          ["kind"],
        );
        const events = [
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: "response-1" },
          },
          {
            type: "response.output_item.done",
            sequence_number: 1,
            item: {
              type: "function_call",
              call_id: "call-1",
              name: "content_read",
              arguments: input,
            },
          },
          {
            type: "response.completed",
            sequence_number: 2,
            response: { id: "response-1", status: "completed", output: [] },
          },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  );
  const events = [];
  for await (const event of transport.stream(
    {
      schemaVersion: "crewon.model-request.v0",
      runId: "run-1",
      segmentId: "segment-1",
      agentVersionId: "agent-1",
      instructions: null,
      input: {
        strategy: "manual",
        items: [{ type: "message", role: "user", content: "Read the brief" }],
      },
      tools: [
        definition({
          type: "object",
          properties: { source, offset: { type: "integer" } },
          required: ["source", "offset"],
          additionalProperties: false,
        }),
      ],
      maxOutputBytes: 8192,
    },
    new AbortController().signal,
  ))
    events.push(event);
  assert.deepEqual(events, [
    {
      type: "output.item.completed",
      item: {
        type: "tool_call",
        kind: "function",
        callId: "call-1",
        name: "content_read",
        input,
      },
    },
    { type: "completed", checkpoint: null },
  ]);
});

test("Responses keeps nested source variants optional without changing the pinned tool schema", () => {
  const schema = {
    type: "object",
    properties: { source, offset: { type: "integer" } },
    required: ["source", "offset"],
    additionalProperties: false,
  };
  const before = structuredClone(schema);
  const tool = toResponsesToolDefinition(definition(schema));
  assert.equal(tool.strict, false);
  assert.deepEqual(tool.parameters, before);
  assert.deepEqual(schema, before);
  const nestedSchemas: Parameters<typeof definition>[0][] = [
    { type: "array", items: source },
    { anyOf: [source, { type: "null" }] },
    { $ref: "#/$defs/source", $defs: { source } },
  ];
  for (const nested of nestedSchemas) {
    assert.equal(
      toResponsesToolDefinition(
        definition({
          type: "object",
          properties: { nested },
          required: ["nested"],
        }),
      ).strict,
      false,
    );
  }
});

test("closed required tools and custom text tools preserve their previous wire representation", () => {
  const schema = {
    type: "object",
    properties: { projectId: { type: "string" } },
    required: ["projectId"],
    additionalProperties: false,
  };
  assert.deepEqual(toResponsesToolDefinition(definition(schema)), {
    type: "function",
    name: "content_read",
    description: "Read one project revision",
    parameters: schema,
  });
  assert.deepEqual(
    toResponsesToolDefinition({
      schemaVersion: "crewon.tool-definition.v0",
      kind: "custom",
      name: "patch",
      description: "Patch",
      execution: "serial",
      inputFormat: "text",
    }),
    {
      type: "custom",
      name: "patch",
      description: "Patch",
      format: { type: "text" },
    },
  );
});
