import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import type { ModelRequest } from "@crewon/agent-kernel";
import { DirectResponsesTransport } from "./direct-responses-transport.ts";
import {
  WebSocketResponsesTransport,
  ResilientResponsesTransport,
} from "./websocket-responses-transport.ts";

for (const kind of ["http", "websocket", "resilient"] as const)
  test(
    `${kind}: spending rejection emits no generation and cannot trigger a retry or HTTP fallback`,
    { timeout: 5000 },
    async (t) => {
      let posts = 0,
        frames = 0,
        admissions = 0;
      const server = createServer((_request, response) => {
        posts++;
        response.writeHead(500).end();
      });
      const sockets = new WebSocketServer({ server });
      sockets.on("connection", (socket) =>
        socket.on("message", () => {
          frames++;
        }),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      t.after(async () => {
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const config = {
        endpoint: `http://127.0.0.1:${address.port}/responses`,
        model: "model",
        maxOutputTokens: 128,
      };
      const transport =
        kind === "http"
          ? new DirectResponsesTransport(config)
          : kind === "websocket"
            ? new WebSocketResponsesTransport(config)
            : new ResilientResponsesTransport({
                ...config,
                websocketMaxRetries: 0,
              });
      if ("close" in transport) t.after(() => transport.close());
      const request: ModelRequest = {
        schemaVersion: "crewon.model-request.v0",
        runId: "run",
        segmentId: "segment",
        agentVersionId: "agent",
        instructions: "stable prefix",
        input: {
          strategy: "manual",
          items: [{ type: "message", role: "user", content: "task" }],
        },
        tools: [],
        maxOutputBytes: 8192,
      };
      await assert.rejects(
        async () => {
          for await (const _event of transport.stream(
            request,
            new AbortController().signal,
            {
              callSink: {
                purpose: "agent",
                record: async () => {
                  admissions++;
                  throw Object.assign(new Error("budget exhausted"), {
                    code: "model_spending_budget_exhausted",
                  });
                },
              },
            },
          )) {
            /* Consumption must reject before any generation. */
          }
        },
        { code: "model_spending_budget_exhausted", retryable: false },
      );
      assert.equal(admissions, 1);
      assert.equal(posts, 0);
      assert.equal(frames, 0);
    },
  );
