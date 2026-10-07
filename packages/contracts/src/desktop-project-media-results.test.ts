import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopProjectExecutionConfiguration as parse } from "./desktop-project-execution-contract.ts";
const digest = `sha256:${"a".repeat(64)}`;
const publication = {
  pluginId: "crewon.short-drama",
  packageDigest: digest,
  contributionId: "workbench",
};
const identity = {
  pluginId: "crewon.short-drama",
  publisherId: "crewon",
  version: "26.0.0",
  packageDigest: digest,
  manifestDigest: digest,
  implementationDigest: digest,
};
const mediaInputs = {
  version: "crewon.desktop-project-media-inputs.v1",
  purposes: ["read", "write"],
  reviews: [
    {
      targetIdentity: identity,
      workflow: {
        workflowId: "krea2-reference-four-view",
        workflowDigest: digest,
        output: { kind: "image", nodeId: "129", dimensions: "workflow-native" },
      },
    },
  ],
  referenceIdentities: [
    {
      pluginId: identity.pluginId,
      pluginVersion: identity.version,
      manifestDigest: digest,
      implementationDigest: digest,
    },
  ],
};
const old = {
  version: "crewon.desktop-project-execution.v1",
  textArtifacts: { version: "crewon.project-text.v1" },
  assetArtifacts: { version: "crewon.project-asset.v1" },
  conversations: { publications: [publication] },
  mediaInputs,
};
const declaration = {
  version: "crewon.desktop-project-media-generations.v1",
  publications: [publication],
};
const options = {
  publications: [{ pluginId: identity.pluginId, packageDigest: digest }],
};

const results = {
  version: "crewon.desktop-project-media-results.v1",
  purposes: ["read"],
  publications: [publication],
};
test("result history is explicit and may remain readable without new generation authority", () => {
  assert.equal(parse(old, options).mediaResults, undefined);
  const mutable = {
    ...old,
    conversations: undefined,
    mediaResults: structuredClone(results),
  };
  delete mutable.conversations;
  const captured = parse(mutable, options);
  assert.deepEqual(captured.mediaResults, results);
  assert.equal(captured.mediaGenerations, undefined);
  mutable.mediaResults.publications[0]!.packageDigest = `sha256:${"b".repeat(64)}`;
  assert.equal(captured.mediaResults!.publications[0]!.packageDigest, digest);
  assert.ok(Object.isFrozen(captured.mediaResults!.purposes));
  const complete = parse(
    {
      ...old,
      mediaGenerations: declaration,
      mediaResults: { ...results, purposes: ["read", "publish"] },
    },
    options,
  );
  assert.deepEqual(complete.mediaResults!.purposes, ["read", "publish"]);
});
test("result publication requires exact reviewed generation package; metadata cannot infer network/write authority", () => {
  for (const patch of [
    { mediaInputs: undefined },
    { mediaResults: { ...results, purposes: ["read", "publish"] } },
    ...[[], ["publish"], ["read", "read"], ["read", "upload"]].map(
      (purposes) => ({ mediaResults: { ...results, purposes } }),
    ),
    { mediaResults: { ...results, publications: [] } },
    { mediaResults: { ...results, publications: [publication, publication] } },
    { mediaResults: { ...results, archiveRoot: "/client" } },
    { mediaResults: { ...results, token: "client-authority" } },
    {
      mediaResults: {
        ...results,
        publications: [{ ...publication, contributionId: "foreign" }],
      },
    },
    {
      mediaResults: {
        ...results,
        publications: [
          { ...publication, packageDigest: `sha256:${"b".repeat(64)}` },
        ],
      },
    },
  ])
    assert.throws(() =>
      parse({ ...old, mediaResults: results, ...patch }, options),
    );
});
