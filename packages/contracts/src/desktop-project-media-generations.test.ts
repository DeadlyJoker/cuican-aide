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
test("Native media generation requires its own declaration; existing metadata and stage scopes infer none", () => {
  assert.equal(parse(old, options).mediaGenerations, undefined);
  const input = { ...old, mediaGenerations: structuredClone(declaration) };
  const result = parse(input, options);
  assert.deepEqual(result.mediaGenerations, declaration);
  input.mediaGenerations.publications[0]!.packageDigest = `sha256:${"b".repeat(64)}`;
  assert.equal(result.mediaGenerations!.publications[0]!.packageDigest, digest);
  assert.ok(Object.isFrozen(result.mediaGenerations!.publications[0]));
});
test("generation declaration rejects unreviewed packages, missing conversations and client authority fields", () => {
  for (const patch of [
    { mediaInputs: undefined },
    { conversations: undefined },
    { mediaGenerations: { ...declaration, publications: [] } },
    {
      mediaGenerations: {
        ...declaration,
        publications: [publication, publication],
      },
    },
    { mediaGenerations: { ...declaration, purposes: ["upload"] } },
    { mediaGenerations: { ...declaration, token: "client" } },
    { mediaGenerations: { ...declaration, archiveRoot: "/client" } },
    {
      mediaGenerations: {
        ...declaration,
        publications: [{ ...publication, contributionId: "foreign" }],
      },
    },
    {
      mediaGenerations: {
        ...declaration,
        publications: [
          { ...publication, packageDigest: `sha256:${"b".repeat(64)}` },
        ],
      },
    },
  ])
    assert.throws(() =>
      parse({ ...old, mediaGenerations: declaration, ...patch }, options),
    );
});
