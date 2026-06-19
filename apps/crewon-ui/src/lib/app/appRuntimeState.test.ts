import { describe, expect, it } from "vitest";

import {
  settledErrorMessages,
  settledMappedValue,
  settledValue,
} from "./appRuntimeState";

describe("app runtime state helpers", () => {
  it("extracts error messages from settled promise results", () => {
    expect(
      settledErrorMessages([
        { status: "fulfilled", value: "ok" },
        { status: "rejected", reason: new Error("offline") },
        { status: "rejected", reason: "plain failure" },
        { status: "rejected", reason: new Error("denied") },
      ]),
    ).toEqual(["offline", "denied"]);
  });

  it("extracts fulfilled values with a fallback", () => {
    expect(settledValue({ status: "fulfilled", value: "ok" }, null)).toBe("ok");
    expect(settledValue({ status: "fulfilled", value: null }, "fallback")).toBe(
      "fallback",
    );
    expect(
      settledValue({ status: "fulfilled", value: undefined }, "fallback"),
    ).toBe("fallback");
    expect(
      settledValue({ status: "rejected", reason: new Error("offline") }, null),
    ).toBeNull();
  });

  it("maps fulfilled values with a fallback", () => {
    expect(
      settledMappedValue(
        { status: "fulfilled", value: { data: ["one"] } },
        (value) => value.data,
        [],
      ),
    ).toEqual(["one"]);
    expect(
      settledMappedValue(
        { status: "fulfilled", value: { data: null } },
        (value) => value.data,
        [],
      ),
    ).toEqual([]);
    expect(
      settledMappedValue(
        { status: "rejected", reason: new Error("offline") },
        () => ["unused"],
        [],
      ),
    ).toEqual([]);
  });
});
