#!/usr/bin/env node

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const options = parseArguments(process.argv.slice(2));
const expectedContent = readFileSync(options.expectedContentFile, "utf8");
const transcript = [];
let responseNumber = 0;

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    transcript.push({
      requestNumber: responseNumber,
      status: "rejected",
      code: error instanceof Error ? error.message : "unknown_error",
    });
    persistTranscript();
    if (!response.headersSent) {
      response.writeHead(400, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ error: "smoke_request_invalid" }));
  });
});

server.listen(options.port, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("smoke_server_address_invalid");
  }
  process.stdout.write(
    `${JSON.stringify({
      status: "ready",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    persistTranscript();
    server.close(() => process.exit(0));
  });
}

async function handle(request, response) {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    throw new Error("smoke_request_route_invalid");
  }
  if (request.headers.authorization !== undefined) {
    throw new Error("smoke_request_credential_unexpected");
  }
  const body = await readJsonBody(request);
  responseNumber += 1;
  if (responseNumber === 1) {
    validateInitialRequest(body);
    transcript.push({
      requestNumber: 1,
      status: "toolRequested",
      model: body.model,
      toolNames: body.tools.map((tool) => `${tool.type}:${tool.name}`),
    });
    persistTranscript();
    writeSse(response, [
      createdEvent("packaged-read-response-1", 0),
      {
        type: "response.output_item.done",
        sequence_number: 1,
        item: {
          type: "function_call",
          call_id: "packaged-read-call-1",
          name: "read_file",
          arguments: JSON.stringify({ path: options.relativePath }),
        },
      },
      completedEvent("packaged-read-response-1", 2, 1, 1),
    ]);
    return;
  }
  if (responseNumber === 2) {
    validateFollowUpRequest(body, expectedContent);
    transcript.push({
      requestNumber: 2,
      status: "toolResultObserved",
      model: body.model,
      outputByteLength: Buffer.byteLength(expectedContent, "utf8"),
    });
    persistTranscript();
    const message = "Packaged read_file completed.";
    writeSse(response, [
      createdEvent("packaged-read-response-2", 0),
      {
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: message,
      },
      {
        type: "response.output_item.done",
        sequence_number: 2,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message }],
        },
      },
      completedEvent("packaged-read-response-2", 3, 2, 2, message),
    ]);
    return;
  }
  throw new Error("smoke_request_count_invalid");
}

function validateInitialRequest(body) {
  requireResponsesBody(body);
  validateReadToolCatalog(body.tools);
  if (
    !Array.isArray(body.input) ||
    body.input.some(
      (item) =>
        item?.type === "function_call" ||
        item?.type === "function_call_output",
    )
  ) {
    throw new Error("smoke_initial_history_invalid");
  }
}

function validateReadToolCatalog(tools) {
  if (tools.length !== 1) {
    throw new Error("smoke_read_file_catalog_invalid");
  }
  const readTool = tools[0];
  if (
    readTool === null ||
    typeof readTool !== "object" ||
    JSON.stringify(Object.keys(readTool).sort()) !==
      JSON.stringify(["description", "name", "parameters", "type"]) ||
    readTool.type !== "function" ||
    readTool.name !== "read_file" ||
    readTool.description !== "Read one bounded file." ||
    readTool.parameters?.type !== "object" ||
    readTool.parameters?.additionalProperties !== false ||
    JSON.stringify(Object.keys(readTool.parameters).sort()) !==
      JSON.stringify([
        "additionalProperties",
        "properties",
        "required",
        "type",
      ]) ||
    JSON.stringify(readTool.parameters?.properties) !==
      JSON.stringify({ path: { type: "string" } }) ||
    JSON.stringify(readTool.parameters?.required) !== JSON.stringify(["path"])
  ) {
    throw new Error("smoke_read_file_catalog_invalid");
  }
}

function validateFollowUpRequest(body, expectedContent) {
  requireResponsesBody(body);
  validateReadToolCatalog(body.tools);
  const call = body.input.find(
    (item) =>
      item?.type === "function_call" &&
      item.call_id === "packaged-read-call-1" &&
      item.name === "read_file",
  );
  const output = body.input.find(
    (item) =>
      item?.type === "function_call_output" &&
      item.call_id === "packaged-read-call-1",
  );
  if (
    call?.arguments !== JSON.stringify({ path: options.relativePath }) ||
    output?.output !== expectedContent
  ) {
    throw new Error("smoke_read_file_result_invalid");
  }
}

function requireResponsesBody(body) {
  if (
    body === null ||
    typeof body !== "object" ||
    body.stream !== true ||
    body.store !== false ||
    typeof body.model !== "string" ||
    !Array.isArray(body.input) ||
    !Array.isArray(body.tools)
  ) {
    throw new Error("smoke_responses_body_invalid");
  }
}

function createdEvent(responseId, sequenceNumber) {
  return {
    type: "response.created",
    sequence_number: sequenceNumber,
    response: { id: responseId },
  };
}

function completedEvent(
  responseId,
  sequenceNumber,
  inputTokens,
  outputTokens,
  output = null,
) {
  return {
    type: "response.completed",
    sequence_number: sequenceNumber,
    response: {
      id: responseId,
      status: "completed",
      output:
        output === null
          ? []
          : [
              {
                type: "message",
                content: [{ type: "output_text", text: output }],
              },
            ],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    },
  };
}

function writeSse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

async function readJsonBody(request) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > 1024 * 1024) {
      throw new Error("smoke_request_body_too_large");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("smoke_request_json_invalid");
  }
}

function persistTranscript() {
  writeFileSync(options.transcript, `${JSON.stringify(transcript, null, 2)}\n`, {
    mode: 0o600,
  });
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("smoke_server_arguments_invalid");
    }
    values.set(key.slice(2), value);
  }
  const expectedContentFile = values.get("expected-content-file");
  const relativePath = values.get("relative-path");
  const transcriptPath = values.get("transcript");
  const port = Number(values.get("port") ?? "0");
  if (
    expectedContentFile === undefined ||
    relativePath === undefined ||
    transcriptPath === undefined ||
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65_535
  ) {
    throw new Error("smoke_server_arguments_invalid");
  }
  return {
    expectedContentFile,
    relativePath,
    transcript: transcriptPath,
    port,
  };
}
