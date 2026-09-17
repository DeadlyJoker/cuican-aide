import { describe, expect, it } from "vitest";
import { once } from "node:events";
import WebSocket from "ws";
import { createSoakModelServer, SOAK_MODEL } from "./model-server.ts";
import { soakPrefixAudit } from "./prefix-audit.ts";

const request = (text: string) => ({
  model: SOAK_MODEL,
  instructions: "Stable instruction",
  input: [{ role: "user", content: text }],
});

describe("isolated soak provider", () => {
  it("streams a distinct assistant acknowledgement and exposes synthetic usage explicitly", async () => {
    const server = await createSoakModelServer({ chunkDelayMs: 0 });
    try {
      const response = await fetch(`${server.origin}/v1/responses`, {
        method: "POST",
        body: JSON.stringify(request("SOAK-1")),
      });
      const events = (await response.text())
        .trim()
        .split("\n\n")
        .map((line) => JSON.parse(line.slice(6)));
      expect(events[0].type).toBe("response.created");
      expect(
        events
          .filter((event) => event.type === "response.output_text.delta")
          .map((event) => event.delta)
          .join(""),
      ).toBe(events.at(-1).response.output[0].content[0].text);
      expect(events.at(-1).response.output[0].content[0].text).toMatch(
        /^ACK SOAK-1\n/,
      );
      expect(server.snapshot()).toMatchObject({
        generations: 1,
        active: 0,
        syntheticUsage: true,
        prefixes: { realCacheHitRate: null },
      });
    } finally {
      await server.close();
    }
  });

  it("makes a disconnected stream's exact response retrievable without generating again", async () => {
    const server = await createSoakModelServer({
      chunkDelayMs: 1,
      faultEvery: 1,
    });
    try {
      const response = await fetch(`${server.origin}/v1/responses`, {
        method: "POST",
        body: JSON.stringify(request("SOAK-2")),
      });
      await expect(response.text()).rejects.toThrow();
      const stored = await (
        await fetch(`${server.origin}/v1/responses/soak_response_1`)
      ).json();
      expect(stored.output[0].content[0].text).toMatch(/^ACK SOAK-2\n/);
      expect(server.snapshot()).toMatchObject({
        generations: 1,
        retrievals: 1,
        injectedDisconnects: 1,
        active: 0,
      });
    } finally {
      await server.close();
    }
  });

  it("supports persistent websocket streaming and closes connected clients", async () => {
    const server = await createSoakModelServer({ chunkDelayMs: 0 });
    const socket = new WebSocket(
      `${server.origin.replace("http:", "ws:")}/v1/responses`,
    );
    try {
      await once(socket, "open");
      for (const marker of ["SOAK-3", "SOAK-4"]) {
        const completed = new Promise<Record<string, unknown>>((resolve) => {
          const listener = (raw: WebSocket.RawData) => {
            const event = JSON.parse(raw.toString());
            if (event.type === "response.completed") {
              socket.off("message", listener);
              resolve(event);
            }
          };
          socket.on("message", listener);
        });
        socket.send(
          JSON.stringify({ type: "response.create", ...request(marker) }),
        );
        expect(await completed).toMatchObject({ type: "response.completed" });
      }
      expect(server.snapshot()).toMatchObject({
        websocketConnections: 1,
        websocketGenerations: 2,
      });
      const closed = once(socket, "close");
      await server.close();
      await closed;
    } finally {
      socket.terminate();
    }
  });

  it("bounds retained response bodies and diagnostic request digests", async () => {
    const server = await createSoakModelServer({ chunkDelayMs: 0 });
    try {
      for (let index = 0; index < 130; index++) {
        const response = await fetch(`${server.origin}/v1/responses`, {
          method: "POST",
          body: JSON.stringify(request(`SOAK-${index}`)),
        });
        await response.text();
      }
      expect(server.snapshot().retainedResponses).toBe(128);
      expect(server.snapshot().recent).toHaveLength(32);
      expect(
        (await fetch(`${server.origin}/v1/responses/soak_response_1`)).status,
      ).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("prefix evidence", () => {
  it("distinguishes appends, rewritten history, configuration changes and response deltas", () => {
    const audit = soakPrefixAudit();
    const first = request("SOAK-1");
    audit.observe(first);
    audit.observe({
      ...first,
      input: [...first.input, { role: "assistant", content: "ACK SOAK-1" }],
    });
    audit.observe(request("rewritten"));
    audit.observe({ ...first, instructions: "changed" });
    audit.observe({ ...first, previous_response_id: "response-1" });
    expect(audit.snapshot()).toMatchObject({
      comparisons: 2,
      matchingPrefixes: 1,
      configurationChanges: 1,
      deltaRequests: 1,
      realCacheHitRate: null,
    });
  });
});
