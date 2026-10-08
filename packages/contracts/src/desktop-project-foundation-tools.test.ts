import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_PROJECT_FOUNDATION_TOOLS_VERSION,
  parseDesktopProjectFoundationToolsConfiguration,
} from "./desktop-project-foundation-tools.ts";
// Schema-only identities. No installation, Run, or UI authority is issued here.
const publication = {
  pluginId: "crewon.short-drama",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const configuration = {
  version: DESKTOP_PROJECT_FOUNDATION_TOOLS_VERSION,
  publications: [publication],
};
const options = {
  publications: [
    {
      pluginId: publication.pluginId,
      packageDigest: publication.packageDigest,
    },
  ],
  metadataPublications: [publication],
};
test("independent Node declaration captures detached frozen exact approved publications", () => {
  const input = structuredClone(configuration);
  const parsed = parseDesktopProjectFoundationToolsConfiguration(
    input,
    options,
  );
  assert.deepEqual(parsed, configuration);
  input.publications[0]!.contributionId = "changed";
  assert.equal(parsed.publications[0]!.contributionId, "workbench");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.publications));
  assert.ok(Object.isFrozen(parsed.publications[0]));
});
test("both approved package and exact metadata tuple are required, with no implicit grant", () => {
  for (const candidate of [
    { ...options, publications: [] },
    { ...options, metadataPublications: [] },
    {
      ...options,
      publications: [
        {
          pluginId: publication.pluginId,
          packageDigest: `sha256:${"b".repeat(64)}`,
        },
      ],
    },
    {
      ...options,
      metadataPublications: [{ ...publication, contributionId: "other" }],
    },
  ])
    assert.throws(() =>
      parseDesktopProjectFoundationToolsConfiguration(configuration, candidate),
    );
  for (const candidate of [
    undefined,
    {},
    { ...configuration, version: "crewon.project-foundation-tools.v2" },
    { ...configuration, publications: [] },
    { ...configuration, publications: [publication, publication] },
    { ...configuration, publications: [{ ...publication, actor: {} }] },
    {
      ...configuration,
      publications: [{ ...publication, packageDigest: "sha256:bad" }],
    },
    { ...configuration, publications: new Array(1) },
    {
      ...configuration,
      publications: Array.from({ length: 33 }, () => publication),
    },
    { ...configuration, ownerPrincipalId: "foreign" },
    { ...configuration, rawBytes: [] },
    { ...configuration, grant: true },
    { ...configuration, extra: "x".repeat(25 * 1024) },
  ])
    assert.throws(() =>
      parseDesktopProjectFoundationToolsConfiguration(candidate, options),
    );
});
test("getters and forged option context are rejected without evaluation", () => {
  let reads = 0;
  const input = { ...configuration };
  Object.defineProperty(input, "publications", {
    enumerable: true,
    get() {
      reads += 1;
      return [publication];
    },
  });
  assert.throws(() =>
    parseDesktopProjectFoundationToolsConfiguration(input, options),
  );
  assert.equal(reads, 0);
  const foreignOptions = { ...options, projectFoundation: {} };
  assert.throws(() =>
    parseDesktopProjectFoundationToolsConfiguration(
      configuration,
      foreignOptions,
    ),
  );
});
