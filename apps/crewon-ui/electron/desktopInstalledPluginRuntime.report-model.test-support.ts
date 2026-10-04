import assert from "node:assert/strict";
import { createServer } from "node:https";
import {
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";

const reportTool = "example_professional__generate";
const permittedTools = new Set([
  reportTool,
  "get_goal",
  "create_goal",
  "update_plan",
]);
type ResponsesItem = Record<string, unknown>;

/** Named HTTPS Responses protocol fixture; completion requires the Worker's actual report tool output. */
export async function nativeInstalledReportModel(
  apiKey: string,
  input: Readonly<{ subject: string }>,
) {
  assert.ok(typeof apiKey === "string" && apiKey.length > 0);
  assert.ok(
    typeof input.subject === "string" &&
      input.subject.trim().length > 0 &&
      input.subject.length <= 2_000,
    "native_report_model_subject_invalid",
  );
  const subject = input.subject;
  const requests: Record<string, unknown>[] = [];
  const failures: unknown[] = [];
  const pending = new Set<Promise<void>>();
  let supplierRequests = 0;
  let emittedCallId: string | null = null;
  let completed = false;
  let closing: Promise<void> | null = null;
  let withdrawn = false;
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) => {
      const work = (async () => {
        if (withdrawn) {
          response.writeHead(503).end();
          return;
        }
        if (request.url?.startsWith("/supplier/")) {
          supplierRequests++;
          response.writeHead(500).end();
          return;
        }
        assert.equal(request.url, "/v1/responses");
        assert.equal(request.method, "POST");
        assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          assert.ok(bytes <= 256 * 1024, "native_report_model_request_limit");
          chunks.push(buffer);
        }
        assert.ok(requests.length < 16, "native_report_model_request_count");
        const current = record(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ),
        );
        requests.push(current);
        assert.equal(current.stream, true);
        assert.ok(Array.isArray(current.tools));
        const tools = current.tools.map(record);
        const names = tools.map((tool) => tool.name);
        assert.ok(names.length <= permittedTools.size);
        assert.equal(new Set(names).size, names.length);
        assert.ok(
          tools.every(
            (tool) =>
              tool.type === "function" &&
              typeof tool.name === "string" &&
              permittedTools.has(tool.name),
          ),
          "native_report_model_unapproved_tool_catalog",
        );
        assert.ok(
          names.includes(reportTool),
          "native_report_model_tool_missing",
        );
        assert.ok(Array.isArray(current.input));
        const items = current.input.map(record);
        const outputs = items.filter(
          (item) => item.type === "function_call_output",
        );
        assert.ok(!completed, "native_report_model_already_completed");
        const id = `named-native-installed-report-response-${requests.length}`;
        let events: readonly ResponsesItem[];
        if (emittedCallId === null) {
          assert.equal(
            outputs.length,
            0,
            "native_report_model_unissued_output",
          );
          assert.ok(
            items.some((item) => savedSubject(item) === subject),
            "native_report_model_saved_subject_missing",
          );
          emittedCallId = `${id}-call`;
          const call = {
            id: emittedCallId,
            type: "function_call",
            call_id: emittedCallId,
            name: reportTool,
            arguments: JSON.stringify({ subject }),
            status: "completed",
          };
          events = [
            created(id),
            {
              type: "response.output_item.done",
              sequence_number: 1,
              output_index: 0,
              item: call,
            },
            finished(id, 2, call),
          ];
        } else {
          assert.equal(outputs.length, 1, "native_report_model_result_missing");
          const output = outputs[0]!;
          assert.equal(output.call_id, emittedCallId);
          assert.equal(typeof output.output, "string");
          const result = record(JSON.parse(output.output as string));
          assert.deepEqual(Object.keys(result), ["report"]);
          assert.ok(
            typeof result.report === "string" &&
              result.report.trim().length > 0 &&
              result.report.length <= 8_000,
            "native_report_model_supplier_report_missing",
          );
          const text = `answer:${result.report}`;
          const message = {
            id: `${id}-message`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
          events = [
            created(id),
            {
              type: "response.output_text.delta",
              sequence_number: 1,
              item_id: message.id,
              output_index: 0,
              content_index: 0,
              delta: text,
            },
            {
              type: "response.output_item.done",
              sequence_number: 2,
              output_index: 0,
              item: message,
            },
            finished(id, 3, message),
          ];
          completed = true;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        );
      })()
        .catch((error: unknown) => {
          failures.push(error);
          if (!response.headersSent) response.writeHead(500).end();
          else response.destroy();
        })
        .finally(() => pending.delete(work));
      pending.add(work);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  return Object.freeze({
    endpoint: `${origin}/v1`,
    supplier: `${origin}/supplier/`,
    requests,
    supplierRequests: () => supplierRequests,
    close(): Promise<void> {
      withdrawn = true;
      return (closing ??= (async () => {
        const errors: unknown[] = [];
        server.closeAllConnections();
        try {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        } catch (error) {
          errors.push(error);
        }
        await Promise.allSettled([...pending]);
        if (failures.length || errors.length)
          throw new AggregateError(
            [...failures, ...errors],
            "native_report_model_failed",
          );
      })());
    },
  });
}

function record(value: unknown): ResponsesItem {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as ResponsesItem;
}

function savedSubject(item: ResponsesItem): unknown {
  if (item.role !== "user" || typeof item.content !== "string")
    return undefined;
  try {
    return record(JSON.parse(item.content)).subject;
  } catch {
    return undefined;
  }
}

function created(id: string): ResponsesItem {
  return {
    type: "response.created",
    sequence_number: 0,
    response: { id, status: "in_progress", output: [] },
  };
}

function finished(
  id: string,
  sequence: number,
  item: ResponsesItem,
): ResponsesItem {
  return {
    type: "response.completed",
    sequence_number: sequence,
    response: {
      id,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        total_tokens: 7,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  };
}
