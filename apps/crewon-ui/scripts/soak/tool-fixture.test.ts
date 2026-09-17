import { describe, expect, it } from "vitest";
import {
  SOAK_FILE_CONTENT,
  SOAK_READ_TOOL,
  soakRequestMarker,
  soakToolStep,
} from "./tool-fixture.ts";

const request = () => ({
  input: [{ role: "user", content: "SOAK-tool-1 Read the file." }] as Record<
    string,
    unknown
  >[],
  tools: [{ type: "function", name: SOAK_READ_TOOL }],
});
const result = (callId: string, content = SOAK_FILE_CONTENT) => ({
  type: "function_call_output",
  call_id: callId,
  output:
    "text\n[structured]\n" +
    JSON.stringify({
      path: "fixture.txt",
      content,
      byteLength: Buffer.byteLength(SOAK_FILE_CONTENT),
      truncated: false,
    }),
});

describe("real MCP fixture plan", () => {
  it("derives all four reads from complete tool boundaries and then permits an acknowledgement", () => {
    const value = request();
    for (let index = 0; index < 4; index++) {
      const plan = soakToolStep(value, "SOAK-tool-1")!;
      expect(plan.completed).toBe(index);
      expect(plan.call?.name).toBe(SOAK_READ_TOOL);
      value.input.push(plan.call!, result(plan.call!.call_id));
    }
    expect(soakToolStep(value, "SOAK-tool-1")).toEqual({
      completed: 4,
      call: null,
    });
    expect(soakRequestMarker(value.input)).toBe("SOAK-tool-1");
  });
  it("rejects missing, conflicting and forged tool results instead of completing a task", () => {
    for (const mode of [
      "missing",
      "wrongBinding",
      "wrongContent",
      "duplicate",
    ]) {
      const value = request(),
        call = soakToolStep(value, "SOAK-tool-1")!.call!;
      value.input.push(call);
      if (mode !== "missing")
        value.input.push(
          result(
            mode === "wrongBinding" ? "other" : call.call_id,
            mode === "wrongContent" ? "fabricated" : SOAK_FILE_CONTENT,
          ),
        );
      if (mode === "duplicate") value.input.push(result(call.call_id));
      expect(() => soakToolStep(value, "SOAK-tool-1")).toThrow();
    }
  });
  it("requires the exact fixture read tool and does not count older turns", () => {
    const value = request();
    value.tools[0]!.name = "write_file";
    expect(() => soakToolStep(value, "SOAK-tool-1")).toThrow(
      "soak_fixture_read_tool_unavailable",
    );
    const clean = request();
    clean.input.unshift({
      type: "function_call_output",
      call_id: "older",
      output: "bad",
    });
    expect(soakToolStep(clean, "SOAK-tool-1")!.completed).toBe(0);
    expect(soakToolStep(request(), "SOAK-1")).toBeNull();
  });
});
