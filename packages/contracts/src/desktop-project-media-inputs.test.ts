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

test("independent UI publication requires the same reviewed short-drama package; old declarations infer no UI grant", () => {
  const mediaInputUi = {
    publications: [{ ...options.publications[0], contributionId: "workbench" }],
  };
  const projects = {
    version: "crewon.desktop-project-execution.v1",
    textArtifacts: { version: "crewon.project-text.v1" },
    assetArtifacts: { version: "crewon.project-asset.v1" },
    mediaInputs: approval,
  };
  assert.equal(execution(projects, options).mediaInputUi, undefined);
  const actual = execution({ ...projects, mediaInputUi }, options);
  assert.deepEqual(actual.mediaInputUi, mediaInputUi);
  assert.ok(Object.isFrozen(actual.mediaInputUi!.publications[0]));
  assert.throws(() =>
    execution({ ...projects, mediaInputs: undefined, mediaInputUi }, options),
  );
  assert.throws(() =>
    execution(
      {
        ...projects,
        mediaInputUi: {
          publications: [
            { ...mediaInputUi.publications[0], actorId: "client" },
          ],
        },
      },
      options,
    ),
  );
  const other = {
    pluginId: "example.other",
    packageDigest: digest,
    contributionId: "workbench",
  };
  assert.throws(() =>
    execution(
      { ...projects, mediaInputUi: { publications: [other] } },
      { publications: [...options.publications, other] },
    ),
  );
  assert.throws(() =>
    history(
      { version: "crewon.desktop-project-history.v1", mediaInputUi },
      options,
    ),
  );
});

test("Agent media stages require independent exact conversation publication and writable reviewed inputs", () => {
  const publication = {
    ...options.publications[0]!,
    contributionId: "workbench",
  };
  const mediaInputStages = {
    version: "crewon.project-media-input-stages.v1",
    publications: [publication],
  };
  const original = {
    version: "crewon.desktop-project-execution.v1",
    textArtifacts: { version: "crewon.project-text.v1" },
    assetArtifacts: { version: "crewon.project-asset.v1" },
    conversations: { publications: [publication] },
    mediaInputs: approval,
  };
  assert.equal(execution(original, options).mediaInputStages, undefined);
  const actual = execution({ ...original, mediaInputStages }, options);
  assert.deepEqual(actual.mediaInputStages, mediaInputStages);
  assert.ok(Object.isFrozen(actual.mediaInputStages!.publications[0]));
  assert.equal(actual.mediaInputUi, undefined);
  assert.equal(actual.pluginGenerations, undefined);
  for (const patch of [
    { conversations: undefined },
    { mediaInputs: undefined },
    { mediaInputs: { ...approval, purposes: ["read"] } },
    {
      conversations: {
        publications: [{ ...publication, contributionId: "another" }],
      },
    },
    {
      mediaInputStages: {
        ...mediaInputStages,
        version: "crewon.project-asset-stages.v1",
      },
    },
    { mediaInputStages: { ...mediaInputStages, publications: [] } },
    {
      mediaInputStages: {
        ...mediaInputStages,
        publications: [publication, publication],
      },
    },
    { mediaInputStages: { ...mediaInputStages, actorId: "client" } },
  ])
    assert.throws(() =>
      execution({ ...original, mediaInputStages, ...patch }, options),
    );
  const other = { ...publication, packageDigest: `sha256:${"b".repeat(64)}` };
  assert.throws(() =>
    execution(
      {
        ...original,
        conversations: { publications: [other] },
        mediaInputStages: { ...mediaInputStages, publications: [other] },
      },
      { publications: [publication, other] },
    ),
  );
  assert.throws(() =>
    history(
      {
        ...original,
        mediaInputStages,
        version: "crewon.desktop-project-history.v1",
      },
      options,
    ),
  );
});
