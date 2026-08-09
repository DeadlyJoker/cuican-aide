import { describe, it, expect, beforeEach } from "vitest";
import {
  attachPimLaunchToken,
  clearPimLaunchToken,
  getPimLaunchToken,
  isPimLaunchSession,
  setPimLaunchToken,
} from "./pimLaunchBridge";

describe("pimLaunchBridge", () => {
  beforeEach(() => {
    clearPimLaunchToken();
  });

  describe("getPimLaunchToken", () => {
    it("returns null when no token is present", () => {
      expect(getPimLaunchToken()).toBeNull();
    });

    it("returns a token previously set via setPimLaunchToken", () => {
      setPimLaunchToken("test-launch-token");
      expect(getPimLaunchToken()).toBe("test-launch-token");
    });

    it("strips Bearer prefix", () => {
      setPimLaunchToken("Bearer my-token");
      expect(getPimLaunchToken()).toBe("my-token");
    });

    it("normalizes surrounding whitespace", () => {
      setPimLaunchToken("  token-with-spaces  ");
      expect(getPimLaunchToken()).toBe("token-with-spaces");
    });

    it("returns null for empty tokens", () => {
      setPimLaunchToken("");
      expect(getPimLaunchToken()).toBeNull();
    });

    it("returns the token as-is when it is only a Bearer prefix (no content)", () => {
      setPimLaunchToken("Bearer ");
      expect(getPimLaunchToken()).toBe("Bearer");
    });
  });

  describe("isPimLaunchSession", () => {
    it("returns false when no token is present", () => {
      expect(isPimLaunchSession()).toBe(false);
    });

    it("returns true when a token is present", () => {
      setPimLaunchToken("active-token");
      expect(isPimLaunchSession()).toBe(true);
    });
  });

  describe("setPimLaunchToken", () => {
    it("overwrites the previous token", () => {
      setPimLaunchToken("first-token");
      setPimLaunchToken("second-token");
      expect(getPimLaunchToken()).toBe("second-token");
    });
  });

  describe("clearPimLaunchToken", () => {
    it("removes the current token", () => {
      setPimLaunchToken("token-to-clear");
      clearPimLaunchToken();
      expect(getPimLaunchToken()).toBeNull();
    });
  });

  describe("attachPimLaunchToken", () => {
    it("adds the X-PIM-Launch-Token header when a token is present", () => {
      setPimLaunchToken("attach-token");
      const headers = new Headers();
      attachPimLaunchToken(headers);
      expect(headers.get("X-PIM-Launch-Token")).toBe("attach-token");
    });

    it("does not overwrite an existing X-PIM-Launch-Token header", () => {
      setPimLaunchToken("bridge-token");
      const headers = new Headers({ "X-PIM-Launch-Token": "existing-token" });
      attachPimLaunchToken(headers);
      expect(headers.get("X-PIM-Launch-Token")).toBe("existing-token");
    });

    it("does nothing when no token is present", () => {
      const headers = new Headers();
      attachPimLaunchToken(headers);
      expect(headers.has("X-PIM-Launch-Token")).toBe(false);
    });

    it("returns the same Headers instance for chaining", () => {
      const headers = new Headers();
      expect(attachPimLaunchToken(headers)).toBe(headers);
    });
  });
});
