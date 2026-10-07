import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopProjectExecutionConfiguration as parse } from "./desktop-project-execution-contract.ts";
import { parseDesktopProjectHistoryConfiguration } from "./desktop-project-history-contract.ts";
const digest = `sha256:${"a".repeat(64)}`;
const publication = {
  pluginId: "crewon.short-drama",
  packageDigest: digest,
  contributionId: "workbench",
};
const identity = {
  ...publication,
  publisherId: "crewon",
  version: "30.0.0",
  manifestDigest: digest,
  implementationDigest: digest,
};
const { contributionId: _, ...targetIdentity } = identity;
const grant = {
  version: "crewon.desktop-project-assets.v2",
  publications: [publication],
};
const input = {
  version: "crewon.desktop-project-execution.v1",
  textArtifacts: { version: "crewon.project-text.v1" },
  assetArtifacts: { version: "crewon.project-asset.v1" },
  assetUi: { publications: [publication] },
  mediaInputs: {
    version: "crewon.desktop-project-media-inputs.v1",
    purposes: ["read"],
    reviews: [
      {
        targetIdentity,
        workflow: {
          workflowId: "krea2-reference-four-view",
          workflowDigest: digest,
          output: {
            kind: "image",
            nodeId: "129",
            dimensions: "workflow-native",
          },
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
  },
  mediaResults: {
    version: "crewon.desktop-project-media-results.v1",
    purposes: ["read"],
    publications: [publication],
  },
  assetV2: grant,
};
const options = { publications: [publication] };
test("Native V2 assets are explicit, frozen and usable without generation grants", () => {
  const mutable = structuredClone(input),
    result = parse(mutable, options);
  assert.deepEqual(result.assetV2, grant);
  assert.equal(result.mediaGenerations, undefined);
  assert.equal(result.pluginGenerations, undefined);
  assert.equal(result.assetRecovery, undefined);
  mutable.assetV2.publications[0]!.packageDigest = `sha256:${"b".repeat(64)}`;
  assert.equal(result.assetV2!.publications[0]!.packageDigest, digest);
  assert.ok(Object.isFrozen(result.assetV2!.publications[0]));
  const { assetV2, ...legacy } = input;
  assert.equal(parse(legacy, options).assetV2, undefined);
});
test("Native V2 assets require the exact asset/result publication and reject wider grants", () => {
  for (const patch of [
    { assetUi: undefined },
    { mediaResults: undefined },
    { assetArtifacts: undefined },
    { assetV2: { ...grant, version: "crewon.desktop-project-assets.v1" } },
    { assetV2: { ...grant, publications: [] } },
    { assetV2: { ...grant, publications: [publication, publication] } },
    {
      assetV2: {
        ...grant,
        publications: [{ ...publication, contributionId: "sidebar" }],
      },
    },
    {
      assetV2: {
        ...grant,
        publications: [
          { ...publication, packageDigest: `sha256:${"b".repeat(64)}` },
        ],
      },
    },
    { assetV2: { ...grant, archiveRoot: "/client" } },
    { assetV2: { ...grant, authorize: true } },
    { mediaResults: { ...input.mediaResults, purposes: ["publish"] } },
  ])
    assert.throws(() => parse({ ...input, ...patch }, options));
  assert.throws(() => parse(input, { publications: [] }));
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(
      { version: "crewon.desktop-project-history.v1", assetV2: grant },
      options,
    ),
  );
});
