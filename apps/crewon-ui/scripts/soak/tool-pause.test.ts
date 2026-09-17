import { describe, expect, it } from "vitest";
import { SoakToolPause } from "./tool-pause.ts";
import { createSoakModelServer, SOAK_MODEL } from "./model-server.ts";
import {
  SOAK_FILE_CONTENT,
  SOAK_READ_TOOL,
  soakPrompt,
} from "./tool-fixture.ts";

describe("one-owner reload barrier", () => {
  it("admits one marker and only pauses its second tool request", async () => {
    const pause = new SoakToolPause();
    pause.arm("SOAK-tool-1");
    for (let n = 0; n < 20000; n++)
      expect(() => pause.arm("SOAK-tool-2")).toThrow();
    await pause.wait("SOAK-tool-1", "fixture_SOAK-tool-1_1");
    await pause.wait("SOAK-tool-2", "fixture_SOAK-tool-2_2");
    expect(pause.snapshot().current?.waiting).toBe(false);
    const held = pause.wait("SOAK-tool-1", "fixture_SOAK-tool-1_2");
    await expect(
      pause.wait("SOAK-tool-1", "fixture_SOAK-tool-1_2"),
    ).rejects.toThrow("duplicate");
    expect(() => pause.release("SOAK-tool-2")).toThrow();
    pause.release("SOAK-tool-1");
    await held;
    expect(pause.snapshot()).toEqual({
      current: null,
      paused: 1,
      released: 1,
      failed: 0,
    });
    pause.close();
    expect(() => pause.arm("SOAK-tool-3")).toThrow();
  });
  it("times out and closes pending generation without retaining a timer", async () => {
    const pause = new SoakToolPause(10);
    pause.arm("SOAK-tool-1");
    await expect(
      pause.wait("SOAK-tool-1", "fixture_SOAK-tool-1_2"),
    ).rejects.toThrow("timeout");
    pause.arm("SOAK-tool-2");
    const stopped = expect(
      pause.wait("SOAK-tool-2", "fixture_SOAK-tool-2_2"),
    ).rejects.toThrow("closed");
    pause.close();
    await stopped;
    expect(pause.snapshot()).toEqual({
      current: null,
      paused: 2,
      released: 0,
      failed: 2,
    });
  });
  it("holds an actual HTTP tool response and releases the same generation", async () => {
    const server = await createSoakModelServer({ chunkDelayMs: 0 });
    try {
      const marker = "SOAK-tool-1";
      const request = {
        model: SOAK_MODEL,
        tools: [{ type: "function", name: SOAK_READ_TOOL }],
        input: [{ role: "user", content: soakPrompt(marker) }] as unknown[],
      };
      const send = () =>
        fetch(`${server.origin}/v1/responses`, {
          method: "POST",
          body: JSON.stringify(request),
        });
      const first = (await (await send()).text())
        .trim()
        .split("\n\n")
        .map((line) => JSON.parse(line.slice(6)))
        .at(-1).response.output[0];
      request.input.push(first, {
        type: "function_call_output",
        call_id: first.call_id,
        output:
          "read\n[structured]\n" +
          JSON.stringify({
            path: "fixture.txt",
            content: SOAK_FILE_CONTENT,
            byteLength: Buffer.byteLength(SOAK_FILE_CONTENT),
            truncated: false,
          }),
      });
      server.armToolPause(marker);
      const response = await send();
      const body = response.text();
      expect(server.snapshot()).toMatchObject({
        generations: 2,
        active: 1,
        toolCallResponses: 1,
        toolPause: { current: { marker, waiting: true } },
      });
      server.releaseToolPause(marker);
      const events = (await body)
        .trim()
        .split("\n\n")
        .map((line) => JSON.parse(line.slice(6)));
      expect(events.at(-1).response.output[0].call_id).toBe(
        "fixture_SOAK-tool-1_2",
      );
      expect(server.snapshot()).toMatchObject({
        generations: 2,
        active: 0,
        toolCallResponses: 2,
        toolPause: { current: null, paused: 1, released: 1, failed: 0 },
        prefixes: {
          comparisons: 1,
          matchingPrefixes: 1,
          realCacheHitRate: null,
        },
      });
    } finally {
      await server.close();
    }
  });
});
