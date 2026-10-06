import { describe, expect, it } from "vitest";
import { captureExecutionSetupPreview } from "./localPluginExecutionSetupValidation";
import {
  ExecutionSetupFixture,
  executionTestParameters,
  historicalQueryPreview,
  mediaGenerationPreview,
} from "../../components/settings/InstalledPluginExecutionSetup.test-support";

it("generation preview matches prepared digests and exposes exactly the upload endpoint, with no extra authority", () => {
  const fixture = new ExecutionSetupFixture();
  const base = { ...fixture.preview(), ...mediaGenerationPreview() };
  const parse = (value: unknown) =>
    captureExecutionSetupPreview(
      value,
      fixture.identity,
      executionTestParameters,
    );
  const result = parse(base);
  expect(
    Object.isFrozen(
      result.mediaGenerationPreparation?.additionalNetworkPaths[0],
    ),
  ).toBe(true);
  expect(result.mediaGenerationPreparation?.alreadyApproved).toBe(false);
  const generation = base.mediaGenerationPreparation;
  for (const patch of [
    { scope: "read-write-inputs" },
    { alreadyApproved: "true" },
    { additionalNetworkPaths: [{ method: "POST", path: "/other" }] },
    { additionalNetworkPaths: [{ method: "GET", path: "/upload/image" }] },
    {
      additionalNetworkPaths: [
        ...generation.additionalNetworkPaths,
        ...generation.additionalNetworkPaths,
      ],
    },
    {
      workflows: [
        {
          ...generation.workflows[0],
          workflowDigest: `sha256:${"f".repeat(64)}`,
        },
      ],
    },
    { workflows: generation.workflows.toReversed() },
    { actor: "forged" },
  ])
    expect(() =>
      parse({
        ...base,
        mediaGenerationPreparation: { ...generation, ...patch },
      }),
    ).toThrow();
  const { mediaInputPreparation: _removed, ...withoutInputs } = base;
  expect(() => parse(withoutInputs)).toThrow();
  let calls = 0;
  const paths = [...generation.additionalNetworkPaths];
  Object.defineProperty(paths, "0", {
    enumerable: true,
    get() {
      calls++;
      return generation.additionalNetworkPaths[0];
    },
  });
  expect(() =>
    parse({
      ...base,
      mediaGenerationPreparation: {
        ...generation,
        additionalNetworkPaths: paths,
      },
    }),
  ).toThrow();
  expect(calls).toBe(0);
});

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
