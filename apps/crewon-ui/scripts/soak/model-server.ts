import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { soakPrefixAudit } from "./prefix-audit.ts";
import { createSoakWorkloadModel } from "./workload-model.ts";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSES = 128;
export const SOAK_MODEL = "crewon-soak-model";

/** Loopback-only deterministic Responses provider. Its usage fields are synthetic, never cache evidence. */
export async function createSoakModelServer(
  options: { chunkDelayMs?: number; faultEvery?: number } = {},
) {
  const responses = new Map<string, Record<string, unknown>>();
  const totals = {
    generations: 0,
    retrievals: 0,
    websocketConnections: 0,
    httpGenerations: 0,
    websocketGenerations: 0,
    inputBytes: 0,
    outputBytes: 0,
    injectedDisconnects: 0,
    active: 0,
    peakActive: 0,
    previousResponseRequests: 0,
    rejectedRequests: 0,
    retainedResponses: 0,
    toolCallResponses: 0,
    toolValidatedFinalResponses: 0,
    compactionResponses: 0,
    resumedToolProgress: 0,
  };
  const recent: {
    responseId: string;
    inputBytes: number;
    configurationDigest: string;
    inputDigest: string;
    previousResponse: boolean;
  }[] = [];
  const abort = new AbortController();
  const prefixes = soakPrefixAudit();
  const workload = createSoakWorkloadModel();
  const send = (target: ServerResponse | WebSocket, event: unknown) => {
    const value = JSON.stringify(event);
    if ("write" in target) return target.write(`data: ${value}\n\n`);
    if (target.readyState !== 1) throw new Error("soak_socket_closed");
    target.send(value);
    return target.bufferedAmount < 1024 * 1024;
  };
  const generate = async (
    value: Record<string, unknown>,
    target: ServerResponse | WebSocket,
  ) => {
    if (
      totals.active >= 4 ||
      value.model !== SOAK_MODEL ||
      !Array.isArray(value.input)
    )
      throw new Error("soak_request_invalid");
    const input = JSON.stringify(value.input);
    if (Buffer.byteLength(input) > MAX_REQUEST_BYTES)
      throw new Error("soak_request_too_large");
    const decision = workload.evaluate(value);
    const marker = decision.marker;
    prefixes.observe(value);
    totals.active++;
    totals.peakActive = Math.max(totals.peakActive, totals.active);
    const id = `soak_response_${++totals.generations}`;
    const n = totals.generations;
    totals["write" in target ? "httpGenerations" : "websocketGenerations"]++;
    const inputBytes = Buffer.byteLength(input);
    totals.inputBytes += inputBytes;
    if (value.previous_response_id) totals.previousResponseRequests++;
    recent.push({
      responseId: id,
      inputBytes,
      inputDigest: createHash("sha256").update(input).digest("hex"),
      configurationDigest: createHash("sha256")
        .update(JSON.stringify([value.instructions, value.tools]))
        .digest("hex"),
      previousResponse: !!value.previous_response_id,
    });
    if (recent.length > 32) recent.shift();
    const output =
      decision.summary ??
      (decision.call
        ? ""
        : `ACK ${marker}\n\n` +
          "Deterministic long-running fixture. 已验证的模拟输出。\n".repeat(
            n % 10 === 0 ? 256 : 64,
          ));
    totals.outputBytes += Buffer.byteLength(output);
    const response = {
      id,
      status: "completed",
      output: decision.call
        ? [decision.call]
        : [
            {
              id: `msg_${id}`,
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: output }],
            },
          ],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 20,
        total_tokens: 120,
      },
    };
    responses.set(id, response);
    if (responses.size > MAX_RESPONSES)
      responses.delete(responses.keys().next().value!);
    totals.retainedResponses = responses.size;
    try {
      let sequence = 0;
      send(target, {
        type: "response.created",
        sequence_number: sequence++,
        response: { id },
      });
      if (decision.summary) totals.compactionResponses++;
      if (decision.resumedToolProgress) totals.resumedToolProgress++;
      if (decision.call) {
        totals.toolCallResponses++;
        send(target, {
          type: "response.output_item.done",
          sequence_number: sequence++,
          item: decision.call,
        });
      } else if (decision.tool) totals.toolValidatedFinalResponses++;
      const step = Math.ceil(output.length / 8);
      for (let offset = 0; offset < output.length; offset += step) {
        if (
          !send(target, {
            type: "response.output_text.delta",
            sequence_number: sequence++,
            item_id: `msg_${id}`,
            output_index: 0,
            content_index: 0,
            delta: output.slice(offset, offset + step),
          })
        ) {
          if ("write" in target)
            await once(target, "drain", {
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(2000),
              ]),
            });
          else throw new Error("soak_consumer_backpressure");
        }
        await delay(options.chunkDelayMs ?? 25, undefined, {
          signal: abort.signal,
        });
        if (
          offset === 0 &&
          options.faultEvery &&
          n % options.faultEvery === 0
        ) {
          totals.injectedDisconnects++;
          if ("write" in target) target.destroy();
          else target.terminate();
          return;
        }
      }
      send(target, {
        type: "response.completed",
        sequence_number: sequence,
        response,
      });
      if ("write" in target) target.end();
    } finally {
      totals.active--;
    }
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url?.startsWith("/account/")) {
        response.setHeader("access-control-allow-origin", "*");
        response.setHeader(
          "access-control-allow-headers",
          "authorization,content-type",
        );
        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
        const path = request.url.slice("/account".length);
        const fixture =
          path === "/api/v1/auth/login" && request.method === "POST"
            ? { access_token: "synthetic-local-account-token" }
            : path === "/api/v1/auth/me" && request.method === "GET"
              ? {
                  id: 1,
                  username: "soak-fixture",
                  email: "soak@example.invalid",
                  role: "user",
                  password_login_enabled: true,
                }
              : path === "/api/v1/auth/wecom/config"
                ? {
                    enabled: false,
                    provider: "wecom",
                    label: "Isolated fixture",
                  }
                : null;
        request.resume();
        response.writeHead(fixture ? 200 : 503, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify(fixture ?? { detail: "isolated_fixture_unavailable" }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ id: SOAK_MODEL, object: "model" }],
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        /^\/v1\/responses\/soak_response_\d+/.test(request.url ?? "")
      ) {
        totals.retrievals++;
        const id = request.url!.split("/").at(-1)!.split("?")[0]!;
        const value = responses.get(id);
        response.writeHead(value ? 200 : 404, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify(value ?? { error: { code: "response_not_found" } }),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(503);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES)
          throw new Error("soak_request_too_large");
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      await generate(value, response);
    })().catch(() => {
      totals.rejectedRequests++;
      response.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const websocket = new WebSocketServer({
    server,
    path: "/v1/responses",
    maxPayload: MAX_REQUEST_BYTES,
    perMessageDeflate: false,
  });
  websocket.on("connection", (socket) => {
    totals.websocketConnections++;
    if (websocket.clients.size > 8) {
      socket.terminate();
      return;
    }
    let active = false;
    socket.on("error", () => {});
    socket.on("message", (raw) => {
      if (active) {
        totals.rejectedRequests++;
        socket.terminate();
        return;
      }
      active = true;
      void (async () => {
        const value = JSON.parse(raw.toString());
        if (value.type !== "response.create")
          throw new Error("soak_frame_invalid");
        await generate(value, socket);
      })()
        .catch(() => {
          totals.rejectedRequests++;
          socket.terminate();
        })
        .finally(() => {
          active = false;
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("soak_server_address_missing");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    snapshot: () => ({
      ...totals,
      recent: [...recent],
      prefixes: prefixes.snapshot(),
      syntheticUsage: true as const,
    }),
    close: async () => {
      abort.abort();
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      responses.clear();
      recent.length = 0;
    },
  };
}
