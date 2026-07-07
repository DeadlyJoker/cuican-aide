import { describe, expect, it } from "vitest";

import {
  backendThreadId,
  isDemoThreadId,
  previewAwareBackendThreadId,
} from "./appUiState";

describe("app UI state helpers", () => {
  it("detects demo thread ids", () => {
    expect(isDemoThreadId("demo-1")).toBe(true);
    expect(isDemoThreadId("thread-1")).toBe(false);
    expect(isDemoThreadId(null)).toBe(false);
    expect(isDemoThreadId(undefined)).toBe(false);
  });

  it("returns only backend thread ids", () => {
    expect(backendThreadId("thread-1")).toBe("thread-1");
    expect(backendThreadId("demo-1")).toBeNull();
    expect(backendThreadId(null)).toBeNull();
    expect(backendThreadId(undefined)).toBeNull();
  });

  it("allows demo ids outside demo preview only", () => {
    expect(previewAwareBackendThreadId("thread-1", true)).toBe("thread-1");
    expect(previewAwareBackendThreadId("demo-1", true)).toBeNull();
    expect(previewAwareBackendThreadId("demo-1", false)).toBe("demo-1");
    expect(previewAwareBackendThreadId(null, false)).toBeNull();
  });
});
