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

it("media preparation preview is bounded and cannot acquire generation/network or unknown workflow scope", () => {
  const fixture = new ExecutionSetupFixture();
  const mediaInputPreparation = {
    scope: "read-write-inputs",
    workflows: [
      {
        workflowId: "krea2-reference-four-view",
        workflowDigest: `sha256:${"a".repeat(64)}`,
      },
    ],
  };
  const parse = (value: unknown) =>
    captureExecutionSetupPreview(
      { ...fixture.preview(), mediaInputPreparation: value },
      fixture.identity,
      executionTestParameters,
    );
  const result = parse(mediaInputPreparation);
  expect(result.mediaInputPreparation).toEqual(mediaInputPreparation);
  expect(Object.isFrozen(result.mediaInputPreparation?.workflows[0])).toBe(
    true,
  );
  for (const value of [
    { ...mediaInputPreparation, scope: "generate" },
    { ...mediaInputPreparation, networkPaths: [] },
    { ...mediaInputPreparation, workflows: [] },
    {
      ...mediaInputPreparation,
      workflows: [
        mediaInputPreparation.workflows[0],
        mediaInputPreparation.workflows[0],
      ],
    },
    {
      ...mediaInputPreparation,
      workflows: [
        { ...mediaInputPreparation.workflows[0], workflowDigest: "bad" },
      ],
    },
    {
      ...mediaInputPreparation,
      workflows: [
        { ...mediaInputPreparation.workflows[0], workflowId: "unknown" },
      ],
    },
  ])
    expect(() => parse(value)).toThrow();
  let calls = 0;
  const workflows = [mediaInputPreparation.workflows[0]];
  Object.defineProperty(workflows, "0", {
    enumerable: true,
    get() {
      calls++;
      return mediaInputPreparation.workflows[0];
    },
  });
  expect(() => parse({ ...mediaInputPreparation, workflows })).toThrow();
  expect(calls).toBe(0);
});
