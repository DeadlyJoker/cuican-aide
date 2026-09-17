import { describe, expect, it } from "vitest";
import {
  configureSoakRendererMemory,
  readSoakRendererHeap,
  SOAK_RENDERER_MEMORY_OBSERVATION,
} from "./renderer-memory.ts";

describe("natural-GC renderer memory observations", () => {
  it("configures fresh observations before Electron is ready and refuses a late change", () => {
    const switches: string[] = [];
    const commandLine = {
      appendSwitch: (value: string) => {
        switches.push(value);
      },
    };
    configureSoakRendererMemory({ isReady: () => false, commandLine });
    expect(switches).toEqual(["enable-precise-memory-info"]);
    expect(() =>
      configureSoakRendererMemory({ isReady: () => true, commandLine }),
    ).toThrow("soak_renderer_memory_configuration_late");
    expect(switches).toHaveLength(1);
  });

  it("preserves fresh heap bytes without rounding or treating total heap as retained memory", () => {
    expect(
      readSoakRendererHeap({
        rendererMemory: SOAK_RENDERER_MEMORY_OBSERVATION,
        renderer: { heap: { used: 22_838_729, total: 32_000_000 } },
      }),
    ).toBe(22_838_729);
    expect(SOAK_RENDERER_MEMORY_OBSERVATION.explicitGc).toBe(false);
  });

  it("rejects historical, cached, diagnostic-GC or mismatched observations", () => {
    for (const rendererMemory of [
      undefined,
      null,
      {},
      { ...SOAK_RENDERER_MEMORY_OBSERVATION, cache: "20-minutes" },
      { ...SOAK_RENDERER_MEMORY_OBSERVATION, precision: "bucketized" },
      { ...SOAK_RENDERER_MEMORY_OBSERVATION, explicitGc: true },
      { ...SOAK_RENDERER_MEMORY_OBSERVATION, api: "different-api" },
    ]) {
      expect(() =>
        readSoakRendererHeap({
          rendererMemory,
          renderer: { heap: { used: 20, total: 40 } },
        }),
      ).toThrow("soak_renderer_memory_observation_mismatch");
    }
  });

  it("keeps missing or malformed heap values from becoming zero or a successful sample", () => {
    for (const heap of [
      null,
      { used: 0, total: 1 },
      { used: -1, total: 1 },
      { used: 2, total: 1 },
      { used: Number.NaN, total: 10 },
      { used: 1.5, total: 10 },
      { used: 1, total: Infinity },
    ]) {
      expect(() =>
        readSoakRendererHeap({
          rendererMemory: SOAK_RENDERER_MEMORY_OBSERVATION,
          renderer: { heap },
        }),
      ).toThrow("soak_renderer_memory_sample_invalid");
    }
  });
});
