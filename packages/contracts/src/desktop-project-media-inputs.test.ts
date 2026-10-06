import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopProjectMediaInputsConfiguration as parse } from "./desktop-project-media-inputs.ts";
import { parseDesktopProjectExecutionConfiguration as execution } from "./desktop-project-execution-contract.ts";
import { parseDesktopProjectHistoryConfiguration as history } from "./desktop-project-history-contract.ts";
const digest = `sha256:${"a".repeat(64)}`;
const identity = {
  pluginId: "crewon.short-drama",
  publisherId: "crewon",
  version: "21.0.1",
  packageDigest: digest,
  manifestDigest: digest,
  implementationDigest: digest,
};
const review = {
  targetIdentity: identity,
  workflow: {
    workflowId: "krea2-reference-four-view",
    workflowDigest: digest,
    output: { kind: "image", nodeId: "129", dimensions: "workflow-native" },
  },
};
const approval = {
  version: "crewon.desktop-project-media-inputs.v1",
  purposes: ["read", "write"],
  reviews: [review],
  referenceIdentities: [
    {
      pluginId: "crewon.comfyui-krea2",
      pluginVersion: "1.0.0",
      manifestDigest: digest,
      implementationDigest: digest,
    },
  ],
};
const options = {
  publications: [{ pluginId: identity.pluginId, packageDigest: digest }],
};
test("independent private media declaration pins purposes, package/graph and original reference decoder identities", () => {
  const actual = parse(approval, options);
  assert.deepEqual(actual, approval);
  assert.ok(Object.isFrozen(actual.reviews[0]!.workflow.output));
  const projects = {
    version: "crewon.desktop-project-execution.v1",
    textArtifacts: { version: "crewon.project-text.v1" },
    assetArtifacts: { version: "crewon.project-asset.v1" },
    mediaInputs: approval,
  };
  assert.deepEqual(execution(projects, options).mediaInputs, approval);
  const { mediaInputs: _, ...old } = projects;
  assert.deepEqual(execution(old, options), old);
  assert.throws(() =>
    history(
      { ...projects, version: "crewon.desktop-project-history.v1" },
      options,
    ),
  );
  assert.throws(() =>
    execution({ ...projects, assetArtifacts: undefined }, options),
  );
  assert.throws(() => parse(approval, { publications: [] }));
});
test("metadata declarations reject inferred execution, duplicates and mismatched workflow or identity", () => {
  for (const patch of [
    { purposes: [] },
    { purposes: ["read", "read"] },
    { purposes: ["write"] },
    { purposes: ["qualify"] },
    { reviews: [review, review] },
    {
      referenceIdentities: [
        ...approval.referenceIdentities,
        ...approval.referenceIdentities,
      ],
    },
    { networkGrants: [] },
    { profileId: "client" },
    { token: "not-a-grant" },
    {
      reviews: [
        {
          ...review,
          workflow: {
            ...review.workflow,
            output: { ...review.workflow.output, nodeId: "17" },
          },
        },
      ],
    },
    {
      reviews: [{ ...review, targetIdentity: { ...identity, version: "21" } }],
    },
    {
      referenceIdentities: [
        { ...approval.referenceIdentities[0], pluginId: "other.provider" },
      ],
    },
  ])
    assert.throws(() => parse({ ...approval, ...patch }, options));
  const d18 = {
    ...review,
    workflow: {
      ...review.workflow,
      workflowId: "flux2-three-reference-storyboard",
      output: { ...review.workflow.output, nodeId: "17" },
    },
  };
  assert.equal(
    parse({ ...approval, reviews: [review, d18] }, options).reviews.length,
    2,
  );
});
test("private approval captures only portable bounded own data and does not evaluate accessor grants", () => {
  let called = 0;
  const getter = Object.defineProperty({ ...approval }, "purposes", {
    enumerable: true,
    get() {
      called++;
      return ["write"];
    },
  });
  assert.throws(() => parse(getter, options));
  assert.equal(called, 0);
  assert.throws(() =>
    parse({ ...approval, reviews: Array(17).fill(review) }, options),
  );
  assert.throws(() =>
    parse(
      {
        ...approval,
        referenceIdentities: Array(33).fill(approval.referenceIdentities[0]),
      },
      options,
    ),
  );
  assert.throws(() =>
    parse(
      approval,
      Object.defineProperty({}, "publications", {
        enumerable: true,
        get() {
          called++;
          return options.publications;
        },
      }) as typeof options,
    ),
  );
  assert.equal(called, 0);
});
