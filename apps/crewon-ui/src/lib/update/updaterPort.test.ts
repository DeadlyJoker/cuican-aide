import { describe, expect, it } from "vitest";

import { resolveUpdaterPort } from "./updaterPort";

describe("resolveUpdaterPort", () => {
  it("returns null without the real Tauri bridge", async () => {
    await expect(resolveUpdaterPort()).resolves.toBeNull();
  });
});
