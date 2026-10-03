import assert from "node:assert/strict";
import { createServer } from "node:https";
import {
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";

export const ordinaryNativeResponse =
  "The existing default Agent remains available.";

/** A real named Responses HTTP provider. It emits text only and cannot execute plugin tools. */
export async function nativeIsolationModel(apiKey: string) {
  const requests: Record<string, unknown>[] = [];
  const failures: unknown[] = [];
  const pending = new Set<Promise<void>>();
  let supplierRequests = 0;
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) => {
      const work = (async () => {
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
          bytes += Buffer.byteLength(chunk);
          assert.ok(bytes <= 256 * 1024);
          chunks.push(Buffer.from(chunk));
        }
        assert.ok(requests.length < 16);
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(input);
        assert.equal(input.stream, true);
        assert.ok(
          !String(JSON.stringify(input.tools)).includes("crewon_comfyui_"),
        );
        assert.ok(
          !String(JSON.stringify(input.tools)).includes("example_professional"),
        );
        const id = `native-isolation-response-${requests.length}`;
        const item = {
          id: `${id}-message`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: ordinaryNativeResponse,
              annotations: [],
            },
          ],
        };
        const events = [
          {
            type: "response.created",
            sequence_number: 0,
            response: { id, status: "in_progress", output: [] },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: ordinaryNativeResponse,
          },
          {
            type: "response.output_item.done",
            sequence_number: 2,
            output_index: 0,
            item,
          },
          {
            type: "response.completed",
            sequence_number: 3,
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
          },
        ];
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
  return {
    endpoint: `${origin}/v1`,
    supplier: `${origin}/supplier/`,
    requests,
    supplierRequests: () => supplierRequests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.allSettled([...pending]);
      if (failures.length)
        throw new AggregateError(failures, "native_isolation_model_failed");
    },
  };
}
