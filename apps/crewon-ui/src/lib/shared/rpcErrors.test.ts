import { describe, expect, it } from "vitest";

import { isMissingThreadError, isUnsupportedRpcError } from "./rpcErrors";

describe("transport-neutral RPC errors", () => {
  it("classifies missing Thread messages", () => {
    expect(isMissingThreadError(new Error("thread not found: thread-1"))).toBe(
      true,
    );
    expect(isMissingThreadError(new Error("invalid thread id"))).toBe(true);
    expect(isMissingThreadError(new Error("permission denied"))).toBe(false);
  });

  it("classifies JSON-RPC method-not-found by code", () => {
    const unsupported = Object.assign(new Error("unsupported"), {
      code: -32601,
    });
    expect(isUnsupportedRpcError(unsupported)).toBe(true);
    expect(
      isUnsupportedRpcError(Object.assign(new Error("conflict"), { code: 409 })),
    ).toBe(false);
    expect(isUnsupportedRpcError({ code: -32601 })).toBe(false);
  });
});
