import { describe, expect, it } from "vitest";
import { captureExecutionSetupPreview } from "./localPluginExecutionSetupValidation";
import {
  ExecutionSetupFixture,
  executionTestParameters,
  historicalQueryPreview,
} from "../../components/settings/InstalledPluginExecutionSetup.test-support";

describe("strict optional historical query preview", () => {
  const fixture = new ExecutionSetupFixture();
  it("preserves the old reply shape and deeply freezes the exact GET-only historical approval", () => {
    const old = captureExecutionSetupPreview(
      fixture.preview(),
      fixture.identity,
      executionTestParameters,
    );
    expect(Object.hasOwn(old, "historyQuery")).toBe(false);
    const parsed = captureExecutionSetupPreview(
      {
        ...fixture.preview(),
        historyQueryAvailability: "available",
        historyQuery: historicalQueryPreview(),
      },
      fixture.identity,
      executionTestParameters,
    );
    expect(parsed.historyQuery).toEqual(historicalQueryPreview());
    expect(Object.isFrozen(parsed.historyQuery)).toBe(true);
    expect(Object.isFrozen(parsed.historyQuery?.target)).toBe(true);
    const unavailable = captureExecutionSetupPreview(
      { ...fixture.preview(), historyQueryAvailability: "unavailable" },
      fixture.identity,
      executionTestParameters,
    );
    expect(unavailable.historyQueryAvailability).toBe("unavailable");
    expect(Object.hasOwn(unavailable, "historyQuery")).toBe(false);
    for (const bad of [
      { ...fixture.preview(), historyQueryAvailability: "available" },
      { ...fixture.preview(), historyQuery: historicalQueryPreview() },
      {
        ...fixture.preview(),
        historyQueryAvailability: "unavailable",
        historyQuery: historicalQueryPreview(),
      },
    ])
      expect(() =>
        captureExecutionSetupPreview(
          bad,
          fixture.identity,
          executionTestParameters,
        ),
      ).toThrow();
  });
  it("rejects foreign source pins, broader scope, POST, hidden grants and missing/unknown fields", () => {
    const h = historicalQueryPreview();
    for (const historyQuery of [
      null,
      { ...h, source: { ...h.source, packageDigest: h.target.packageDigest } },
      { ...h, source: { ...h.source, contributionId: "other" } },
      { ...h, target: { ...h.target, pluginId: "example.foreign" } },
      { ...h, target: { ...h.target, action: "image.generate" } },
      { ...h, target: { ...h.target, configurationRevision: 1 } },
      { ...h, methods: ["POST"] },
      { ...h, methods: ["GET", "POST"] },
      { ...h, scope: "generation" },
      { ...h, selectionRevision: 0 },
      { ...h, configurationRevision: 1.5 },
      { ...h, configurationDigest: "sha256:wrong" },
      { ...h, actor: "forged" },
    ])
      expect(() =>
        captureExecutionSetupPreview(
          {
            ...fixture.preview(),
            historyQueryAvailability: "available",
            historyQuery,
          },
          fixture.identity,
          executionTestParameters,
        ),
      ).toThrow();
  });
  it("does not read accessor or sparse method entries", () => {
    const methods: unknown[] = [];
    methods.length = 1;
    const accessor = ["GET"];
    let calls = 0;
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        calls++;
        return "GET";
      },
    });
    for (const value of [methods, accessor])
      expect(() =>
        captureExecutionSetupPreview(
          {
            ...fixture.preview(),
            historyQueryAvailability: "available",
            historyQuery: { ...historicalQueryPreview(), methods: value },
          },
          fixture.identity,
          executionTestParameters,
        ),
      ).toThrow();
    expect(calls).toBe(0);
  });
});
